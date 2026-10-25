import { ExpressionSyntaxError, tokenize, type Token, type TokenKind } from "./lexer.js";

export type Node =
  | { type: "literal"; value: null | boolean | number | string }
  | { type: "context"; name: string }
  | { type: "index"; object: Node; index: Node | "*" }
  | { type: "call"; name: string; args: Node[] }
  | { type: "not"; operand: Node }
  | { type: "binary"; op: "==" | "!=" | "<" | "<=" | ">" | ">="; left: Node; right: Node }
  | { type: "logical"; op: "&&" | "||"; left: Node; right: Node };

/** Built-in functions: lower-cased name -> [min args, max args]. */
export const FUNCTIONS: Record<string, { name: string; min: number; max: number }> = {
  contains: { name: "contains", min: 2, max: 2 },
  startswith: { name: "startsWith", min: 2, max: 2 },
  endswith: { name: "endsWith", min: 2, max: 2 },
  format: { name: "format", min: 1, max: Infinity },
  join: { name: "join", min: 1, max: 2 },
  tojson: { name: "toJSON", min: 1, max: 1 },
  fromjson: { name: "fromJSON", min: 1, max: 1 },
  hashfiles: { name: "hashFiles", min: 1, max: Infinity },
  success: { name: "success", min: 0, max: 0 },
  failure: { name: "failure", min: 0, max: 0 },
  cancelled: { name: "cancelled", min: 0, max: 0 },
  always: { name: "always", min: 0, max: 0 },
};

export const STATUS_FUNCTIONS = new Set(["success", "failure", "cancelled", "always"]);

class Parser {
  private i = 0;
  constructor(
    private readonly src: string,
    private readonly tokens: Token[],
  ) {}

  private peek(): Token {
    return this.tokens[this.i]!;
  }
  private next(): Token {
    return this.tokens[this.i++]!;
  }
  private fail(message: string, tok: Token = this.peek()): never {
    throw new ExpressionSyntaxError(message, this.src, tok.pos);
  }
  private expect(kind: TokenKind): Token {
    const t = this.peek();
    if (t.kind !== kind) this.fail(`Expected '${kind}' but found ${describe(t)}`);
    return this.next();
  }

  parse(): Node {
    if (this.peek().kind === "eof") this.fail("Empty expression");
    const node = this.parseOr();
    if (this.peek().kind !== "eof") this.fail(`Unexpected ${describe(this.peek())}`);
    return node;
  }

  private parseOr(): Node {
    let left = this.parseAnd();
    while (this.peek().kind === "||") {
      this.next();
      left = { type: "logical", op: "||", left, right: this.parseAnd() };
    }
    return left;
  }

  private parseAnd(): Node {
    let left = this.parseEquality();
    while (this.peek().kind === "&&") {
      this.next();
      left = { type: "logical", op: "&&", left, right: this.parseEquality() };
    }
    return left;
  }

  private parseEquality(): Node {
    let left = this.parseComparison();
    for (;;) {
      const k = this.peek().kind;
      if (k !== "==" && k !== "!=") return left;
      this.next();
      left = { type: "binary", op: k, left, right: this.parseComparison() };
    }
  }

  private parseComparison(): Node {
    let left = this.parseUnary();
    for (;;) {
      const k = this.peek().kind;
      if (k !== "<" && k !== "<=" && k !== ">" && k !== ">=") return left;
      this.next();
      left = { type: "binary", op: k, left, right: this.parseUnary() };
    }
  }

  private parseUnary(): Node {
    if (this.peek().kind === "!") {
      this.next();
      return { type: "not", operand: this.parseUnary() };
    }
    return this.parsePostfix(this.parsePrimary());
  }

  private parsePostfix(node: Node): Node {
    for (;;) {
      const t = this.peek();
      if (t.kind === ".") {
        this.next();
        const p = this.peek();
        if (p.kind === "*") {
          this.next();
          node = { type: "index", object: node, index: "*" };
        } else if (p.kind === "ident" || p.kind === "true" || p.kind === "false" || p.kind === "null") {
          this.next();
          node = { type: "index", object: node, index: { type: "literal", value: p.text } };
        } else {
          this.fail(`Expected property name after '.' but found ${describe(p)}`);
        }
      } else if (t.kind === "[") {
        this.next();
        if (this.peek().kind === "*") {
          this.next();
          this.expect("]");
          node = { type: "index", object: node, index: "*" };
        } else {
          const index = this.parseOr();
          this.expect("]");
          node = { type: "index", object: node, index };
        }
      } else {
        return node;
      }
    }
  }

  private parsePrimary(): Node {
    const t = this.next();
    switch (t.kind) {
      case "number":
      case "string":
        return { type: "literal", value: t.value! };
      case "true":
        return { type: "literal", value: true };
      case "false":
        return { type: "literal", value: false };
      case "null":
        return { type: "literal", value: null };
      case "(": {
        const inner = this.parseOr();
        this.expect(")");
        return inner;
      }
      case "ident": {
        if (this.peek().kind === "(") {
          this.next();
          const fn = FUNCTIONS[t.text.toLowerCase()];
          if (!fn) this.fail(`Unrecognized function '${t.text}'`, t);
          const args: Node[] = [];
          if (this.peek().kind !== ")") {
            for (;;) {
              args.push(this.parseOr());
              if (this.peek().kind === ",") {
                this.next();
                continue;
              }
              break;
            }
          }
          this.expect(")");
          if (args.length < fn.min || args.length > fn.max) {
            const expected = fn.min === fn.max ? `${fn.min}` : fn.max === Infinity ? `at least ${fn.min}` : `${fn.min}-${fn.max}`;
            this.fail(`Function '${fn.name}' expects ${expected} argument(s) but got ${args.length}`, t);
          }
          return { type: "call", name: t.text.toLowerCase(), args };
        }
        return { type: "context", name: t.text };
      }
      default:
        return this.fail(`Unexpected ${describe(t)}`, t);
    }
  }
}

function describe(t: Token): string {
  return t.kind === "eof" ? "end of expression" : `'${t.text}'`;
}

const cache = new Map<string, Node>();

/** Parses an expression (without the surrounding `${{ }}`). Throws ExpressionSyntaxError. */
export function parseExpression(src: string): Node {
  const hit = cache.get(src);
  if (hit) return hit;
  const node = new Parser(src, tokenize(src)).parse();
  if (cache.size > 2000) cache.clear();
  cache.set(src, node);
  return node;
}

/** True if the AST calls success(), failure(), cancelled() or always(). */
export function usesStatusFunction(node: Node): boolean {
  switch (node.type) {
    case "call":
      return STATUS_FUNCTIONS.has(node.name) || node.args.some(usesStatusFunction);
    case "index":
      return usesStatusFunction(node.object) || (node.index !== "*" && usesStatusFunction(node.index));
    case "not":
      return usesStatusFunction(node.operand);
    case "binary":
    case "logical":
      return usesStatusFunction(node.left) || usesStatusFunction(node.right);
    default:
      return false;
  }
}
