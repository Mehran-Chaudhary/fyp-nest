/**
 * Arithmetic for agents, without `eval`.
 *
 * The proposal names mathematically incorrect answers to financial questions
 * as a known weakness of language models (section 7). A calculator tool is the
 * standard remedy: the model decides *what* to compute and the platform
 * computes it exactly.
 *
 * A hand-written recursive-descent parser over a closed grammar — numbers,
 * `+ - * / % ^`, parentheses, and a fixed set of functions and constants. There
 * are no identifiers beyond those, no assignment, no property access, and
 * nothing is ever handed to a JavaScript evaluator, so no input can do anything
 * but arithmetic. Input length, token count and nesting depth are bounded.
 *
 *     expression := term (('+' | '-') term)*
 *     term       := unary (('*' | '/' | '%') unary)*
 *     unary      := ('+' | '-') unary | power
 *     power      := primary ('^' unary)?          (right-associative)
 *     primary    := number | constant | function '(' args ')' | '(' expression ')'
 */

export class CalculatorError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'CalculatorError';
  }
}

export const CALCULATOR_LIMITS = {
  maxLength: 500,
  maxTokens: 250,
  maxDepth: 32,
} as const;

type Token =
  | { kind: 'number'; value: number }
  | { kind: 'name'; value: string }
  | { kind: 'op'; value: string };

const FUNCTIONS: Readonly<
  Record<string, { arity: [number, number]; fn: (...args: number[]) => number }>
> = {
  sqrt: { arity: [1, 1], fn: Math.sqrt },
  abs: { arity: [1, 1], fn: Math.abs },
  floor: { arity: [1, 1], fn: Math.floor },
  ceil: { arity: [1, 1], fn: Math.ceil },
  exp: { arity: [1, 1], fn: Math.exp },
  ln: { arity: [1, 1], fn: Math.log },
  log: { arity: [1, 1], fn: Math.log10 },
  log10: { arity: [1, 1], fn: Math.log10 },
  pow: { arity: [2, 2], fn: Math.pow },
  min: { arity: [1, 20], fn: Math.min },
  max: { arity: [1, 20], fn: Math.max },
  round: {
    arity: [1, 2],
    fn: (value: number, digits = 0) => {
      if (!Number.isInteger(digits) || digits < 0 || digits > 12) {
        throw new CalculatorError('round() takes 0 to 12 decimal places.');
      }
      const factor = 10 ** digits;
      return Math.round((value + Number.EPSILON) * factor) / factor;
    },
  },
};

const CONSTANTS: Readonly<Record<string, number>> = { pi: Math.PI, e: Math.E };

export function evaluateExpression(expression: string): number {
  if (typeof expression !== 'string' || expression.trim().length === 0) {
    throw new CalculatorError('The expression is empty.');
  }
  if (expression.length > CALCULATOR_LIMITS.maxLength) {
    throw new CalculatorError(
      `Expressions are limited to ${CALCULATOR_LIMITS.maxLength} characters.`,
    );
  }

  const parser = new Parser(tokenize(expression));
  const value = parser.parse();
  if (!Number.isFinite(value)) {
    throw new CalculatorError('The result is not a finite number (division by zero?).');
  }
  // -0 reads badly in an answer.
  return Object.is(value, -0) ? 0 : value;
}

/** A readable rendering: up to 12 significant digits, no exponent for ordinary magnitudes. */
export function formatNumber(value: number): string {
  if (Number.isInteger(value) && Math.abs(value) < 1e15) return String(value);
  const rounded = Number(value.toPrecision(12));
  return Math.abs(rounded) >= 1e-6 && Math.abs(rounded) < 1e15
    ? String(rounded)
    : rounded.toExponential(8);
}

function tokenize(input: string): Token[] {
  const tokens: Token[] = [];
  let index = 0;

  while (index < input.length) {
    const character = input[index];

    if (/\s/.test(character)) {
      index += 1;
      continue;
    }

    const number = /^(?:\d+(?:\.\d*)?|\.\d+)(?:[eE][+-]?\d+)?/.exec(input.slice(index));
    if (number) {
      tokens.push({ kind: 'number', value: Number(number[0]) });
      index += number[0].length;
    } else if (/[A-Za-z]/.test(character)) {
      const name = /^[A-Za-z][A-Za-z0-9]*/.exec(input.slice(index)) as RegExpExecArray;
      tokens.push({ kind: 'name', value: name[0].toLowerCase() });
      index += name[0].length;
    } else if ('+-*/%^(),'.includes(character)) {
      tokens.push({ kind: 'op', value: character });
      index += 1;
    } else if (character === '×') {
      tokens.push({ kind: 'op', value: '*' });
      index += 1;
    } else if (character === '÷') {
      tokens.push({ kind: 'op', value: '/' });
      index += 1;
    } else {
      throw new CalculatorError(`Unexpected character "${character}".`);
    }

    if (tokens.length > CALCULATOR_LIMITS.maxTokens) {
      throw new CalculatorError('The expression is too long.');
    }
  }

  return tokens;
}

class Parser {
  private position = 0;
  private depth = 0;

  constructor(private readonly tokens: Token[]) {}

  parse(): number {
    const value = this.expression();
    if (this.position < this.tokens.length) {
      throw new CalculatorError(`Unexpected "${describe(this.tokens[this.position])}".`);
    }
    return value;
  }

  private expression(): number {
    let value = this.term();
    for (;;) {
      if (this.accept('+')) value += this.term();
      else if (this.accept('-')) value -= this.term();
      else return value;
    }
  }

  private term(): number {
    let value = this.unary();
    for (;;) {
      if (this.accept('*')) value *= this.unary();
      else if (this.accept('/')) value /= this.unary();
      else if (this.accept('%')) value %= this.unary();
      else return value;
    }
  }

  private unary(): number {
    return this.nested(() => {
      if (this.accept('-')) return -this.unary();
      if (this.accept('+')) return this.unary();
      return this.power();
    });
  }

  private power(): number {
    const base = this.primary();
    return this.accept('^') ? base ** this.unary() : base;
  }

  private primary(): number {
    const token = this.tokens[this.position];
    if (!token) throw new CalculatorError('The expression ends unexpectedly.');

    if (token.kind === 'number') {
      this.position += 1;
      return token.value;
    }

    if (token.kind === 'name') {
      this.position += 1;
      if (token.value in CONSTANTS && !this.peek('(')) return CONSTANTS[token.value];
      const definition = FUNCTIONS[token.value];
      if (!definition)
        throw new CalculatorError(`Unknown function or constant "${token.value}".`);

      this.expect('(');
      const args: number[] = [];
      if (!this.peek(')')) {
        do {
          args.push(this.nested(() => this.expression()));
        } while (this.accept(','));
      }
      this.expect(')');

      const [min, max] = definition.arity;
      if (args.length < min || args.length > max) {
        throw new CalculatorError(
          `${token.value}() takes ${min === max ? min : `${min} to ${max}`} argument(s).`,
        );
      }
      return definition.fn(...args);
    }

    if (this.accept('(')) {
      const value = this.nested(() => this.expression());
      this.expect(')');
      return value;
    }

    throw new CalculatorError(`Unexpected "${describe(token)}".`);
  }

  private nested<T>(operation: () => T): T {
    this.depth += 1;
    if (this.depth > CALCULATOR_LIMITS.maxDepth) {
      throw new CalculatorError('The expression is nested too deeply.');
    }
    try {
      return operation();
    } finally {
      this.depth -= 1;
    }
  }

  private peek(op: string): boolean {
    const token = this.tokens[this.position];
    return token?.kind === 'op' && token.value === op;
  }

  private accept(op: string): boolean {
    if (!this.peek(op)) return false;
    this.position += 1;
    return true;
  }

  private expect(op: string): void {
    if (!this.accept(op)) {
      const token = this.tokens[this.position];
      throw new CalculatorError(
        token ? `Expected "${op}" but found "${describe(token)}".` : `Expected "${op}".`,
      );
    }
  }
}

function describe(token: Token): string {
  return String(token.value);
}
