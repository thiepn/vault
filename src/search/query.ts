export type PropertyOperator = 'exists' | '=' | '!=' | '>' | '>=' | '<' | '<=';

export type SearchClause =
  | { kind: 'text'; value: string; phrase: boolean }
  | { kind: 'tag'; value: string }
  | { kind: 'path'; value: string }
  | { kind: 'file'; value: string }
  | { kind: 'task'; value: 'open' | 'done' | 'any' | 'overdue' | 'today' | 'upcoming' | 'undated' | 'recurring' | 'scheduled' | 'due' | 'high' | 'medium' | 'low' }
  | { kind: 'property'; name: string; operator: PropertyOperator; value: string | null };

export type SearchAst =
  | { kind: 'clause'; clause: SearchClause }
  | { kind: 'and'; left: SearchAst; right: SearchAst }
  | { kind: 'or'; left: SearchAst; right: SearchAst }
  | { kind: 'not'; value: SearchAst };

type Token =
  | { type: 'word'; value: string }
  | { type: 'phrase'; value: string }
  | { type: 'and' | 'or' | 'not' | 'lparen' | 'rparen' };

export class SearchQueryError extends Error {
  constructor(message: string, readonly position: number) {
    super(message);
    this.name = 'SearchQueryError';
  }
}

function lex(input: string): Token[] {
  const tokens: Token[] = [];
  let index = 0;
  while (index < input.length) {
    const character = input[index]!;
    if (/\s/u.test(character)) { index++; continue; }
    if (character === '(') { tokens.push({ type: 'lparen' }); index++; continue; }
    if (character === ')') { tokens.push({ type: 'rparen' }); index++; continue; }
    if (character === '"') {
      const start = index++;
      let value = '';
      let closed = false;
      while (index < input.length) {
        const next = input[index]!;
        if (next === '\\' && index + 1 < input.length) {
          value += input[index + 1]!;
          index += 2;
          continue;
        }
        if (next === '"') { closed = true; index++; break; }
        value += next;
        index++;
      }
      if (!closed) throw new SearchQueryError('Unterminated quoted phrase.', start);
      if (value) tokens.push({ type: 'phrase', value });
      continue;
    }

    const start = index;
    while (index < input.length && !/\s|[()]/u.test(input[index]!)) index++;
    let value = input.slice(start, index);
    if (!value) continue;

    if (value.startsWith('-') && value.length > 1) {
      tokens.push({ type: 'not' });
      value = value.slice(1);
    }

    const upper = value.toUpperCase();
    if (upper === 'AND') tokens.push({ type: 'and' });
    else if (upper === 'OR') tokens.push({ type: 'or' });
    else if (upper === 'NOT') tokens.push({ type: 'not' });
    else tokens.push({ type: 'word', value });
  }
  return tokens;
}

function propertyClause(payload: string): SearchClause {
  const match = /^([^!<>=]+?)(>=|<=|!=|=|>|<)(.*)$/u.exec(payload);
  if (!match) {
    const name = payload.trim();
    if (!name) throw new SearchQueryError('Property name is missing.', 0);
    return { kind: 'property', name, operator: 'exists', value: null };
  }
  const name = match[1]!.trim();
  const value = match[3]!.trim();
  if (!name) throw new SearchQueryError('Property name is missing.', 0);
  if (!value) throw new SearchQueryError('Property comparison value is missing.', 0);
  return { kind: 'property', name, operator: match[2]! as PropertyOperator, value };
}

function clauseFromWord(value: string, phrase = false): SearchClause {
  if (phrase) return { kind: 'text', value, phrase: true };
  const colon = value.indexOf(':');
  if (colon <= 0) return { kind: 'text', value, phrase: false };

  const field = value.slice(0, colon).toLocaleLowerCase();
  const payload = value.slice(colon + 1);
  if (field === 'tag') return { kind: 'tag', value: payload.replace(/^#/u, '') };
  if (field === 'path') return { kind: 'path', value: payload };
  if (field === 'file') return { kind: 'file', value: payload };
  if (field === 'task') {
    const task = payload.toLocaleLowerCase();
    if (task === 'open' || task === 'todo') return { kind: 'task', value: 'open' };
    if (task === 'done' || task === 'completed' || task === 'closed') return { kind: 'task', value: 'done' };
    if (task === 'overdue' || task === 'today' || task === 'upcoming' || task === 'undated' || task === 'recurring' || task === 'scheduled' || task === 'due' || task === 'high' || task === 'medium' || task === 'low') {
      return { kind: 'task', value: task };
    }
    return { kind: 'task', value: 'any' };
  }
  if (field === 'property') return propertyClause(payload);
  return { kind: 'text', value, phrase: false };
}

class Parser {
  private index = 0;
  constructor(private readonly tokens: readonly Token[]) {}

  parse(): SearchAst | null {
    if (!this.tokens.length) return null;
    const ast = this.parseOr();
    if (this.index < this.tokens.length) throw new SearchQueryError('Unexpected search token.', this.index);
    return ast;
  }

  private peek(): Token | undefined { return this.tokens[this.index]; }
  private take(): Token { return this.tokens[this.index++]!; }

  private parseOr(): SearchAst {
    let left = this.parseAnd();
    while (this.peek()?.type === 'or') {
      this.take();
      left = { kind: 'or', left, right: this.parseAnd() };
    }
    return left;
  }

  private parseAnd(): SearchAst {
    let left = this.parseUnary();
    while (true) {
      const next = this.peek();
      if (!next || next.type === 'or' || next.type === 'rparen') break;
      if (next.type === 'and') this.take();
      left = { kind: 'and', left, right: this.parseUnary() };
    }
    return left;
  }

  private parseUnary(): SearchAst {
    if (this.peek()?.type === 'not') {
      this.take();
      return { kind: 'not', value: this.parseUnary() };
    }
    return this.parsePrimary();
  }

  private parsePrimary(): SearchAst {
    const token = this.take();
    if (!token) throw new SearchQueryError('Expected a search term.', this.index);
    if (token.type === 'lparen') {
      const value = this.parseOr();
      if (this.peek()?.type !== 'rparen') throw new SearchQueryError('Missing closing parenthesis.', this.index);
      this.take();
      return value;
    }
    if (token.type === 'word') return { kind: 'clause', clause: clauseFromWord(token.value) };
    if (token.type === 'phrase') return { kind: 'clause', clause: clauseFromWord(token.value, true) };
    throw new SearchQueryError('Expected a search term.', this.index - 1);
  }
}

export function parseSearchQuery(input: string): SearchAst | null {
  return new Parser(lex(input.trim())).parse();
}

export function positiveClauses(ast: SearchAst | null): SearchClause[] {
  if (!ast) return [];
  switch (ast.kind) {
    case 'clause': return [ast.clause];
    case 'and':
    case 'or': return [...positiveClauses(ast.left), ...positiveClauses(ast.right)];
    case 'not': return [];
  }
}
