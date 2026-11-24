import { describe, it, expect, afterEach, beforeAll, vi } from 'vitest';
import { EditorState, EditorSelection, type ChangeSpec } from '@codemirror/state';
import { EditorView, runScopeHandlers } from '@codemirror/view';
import { ensureSyntaxTree, getIndentUnit } from '@codemirror/language';
import { CompletionContext, selectedCompletion, startCompletion, insertBracket } from '@codemirror/autocomplete';
import { highlightTree, classHighlighter } from '@lezer/highlight';
import { characterCount, codePoints } from './presentation';
import { detectLanguage, filenameLanguage, inferIndentation } from './languages';
import { grammar } from './grammars';
import { EditorHost, defaultEditorOptions, type EditorMetrics } from './index';
import { localCompletions } from './assistance';

describe('language identification', () => {
  it.each([
    ['def greet(name):\n    return f"Hi {name}"', 'Python'], ['fn main() { println!("hi"); }', 'Rust'],
    ['SELECT a FROM titles;', 'SQL'], ['#!/usr/bin/env -S python3 -u', 'Python'],
    ['const counter: number = 0;', 'TypeScript'], ['function greet() { return 1; }', 'JavaScript'],
    ['<svelte:head><title>Hello</title></svelte:head>', 'Svelte'], ['# Heading', 'Markdown'],
    ['key: value\nitems: 2', 'YAML'], ['{"a": false}', 'JSON'], ['This is a note.', 'Plain Text'],
    ['constructor', 'Plain Text'], ['#!/bin/bash\necho hi', 'Shell'],
  ])('detects %j as %s', (sample, language) => expect(detectLanguage(sample)).toBe(language));
  it('gives paths priority and stays stable on ambiguous input', () => {
    expect(detectLanguage('def foo():', 'notes.txt')).toBe('Plain Text');
    expect(detectLanguage('return x', null, 'Python')).toBe('Python');
    expect(filenameLanguage('C:\\some path\\.git\\config')).toBe('Git Config');
    expect(filenameLanguage('/sources/Containerfile.dev')).toBe('Dockerfile');
    expect(filenameLanguage('example.TsX')).toBe('TSX');
    expect(filenameLanguage('constructor')).toBeUndefined();
  });
  it('infers indentation without treating alignment as an indent step', () => {
    expect(inferIndentation('a\n  b\n    c\n  d')).toEqual({width:2,tabs:false});
    expect(inferIndentation('a\n\tb\n\t\tc')).toEqual({tabs:true});
    expect(inferIndentation('abc')).toBeNull();
  });
  it.each([
    ['JavaScript','function greet() { return "ok"; }'], ['Python','def fn(a):\n    return 1'],
    ['Rust','fn main() {}'], ['Kotlin','fun main() {}'], ['JSONC','{"k": true /* note */}'],
    ['Svelte','<p>{message}</p>'], ['C#','class Foo {}'], ['PowerShell','Write-Host "hello"'],
  ])('bundles a working %s highlighter', (language, text) => {
    const state = EditorState.create({doc:text, extensions:[grammar(language)]});
    const tree = ensureSyntaxTree(state, text.length, 500)!;
    let tokens = 0;
    highlightTree(tree,classHighlighter,() => tokens++);
    expect(tokens).toBeGreaterThan(0);
  });
});

describe('Unicode count', () => {
  it('counts code points, including each normalized newline and combining mark', () => {
    expect(codePoints('a🌍\ne\u0301')).toBe(5);
  });
  it('agrees with a complete recount for adjacent, batched and split-surrogate edits', () => {
    let state = EditorState.create({doc:'☕🌏\nab🪁',extensions:[characterCount]});
    let seed = 11927;
    const random = (max: number) => { seed = (seed * 1664525 + 1013904223) >>> 0; return seed % (max + 1); };
    for (let i = 0; i < 220; i++) {
      const changes: ChangeSpec[] = [];
      let end = 0;
      for (let j = 0; j < 2; j++) {
        const from = end + random(state.doc.length - end);
        end = from + random(state.doc.length - from);
        changes.push({from,to:end,insert:['','a','\n','🫒','\uD800','\uDC00'][random(5)]});
      }
      state = state.update({changes}).state;
      expect(state.field(characterCount)).toBe(Array.from(state.doc.toString()).length);
    }
  });
});

let host: EditorHost | undefined;
const latest = new Map<string, EditorMetrics>();
beforeAll(() => {
  // jsdom has no layout engine; CodeMirror's measurement interface expects these DOM methods.
  Range.prototype.getClientRects ??= () => [] as unknown as DOMRectList;
  Range.prototype.getBoundingClientRect ??= () => new DOMRect();
});
afterEach(() => { host?.destroy(); host = undefined; latest.clear(); document.body.replaceChildren(); });
function setup(text = '', path: string | null = null) {
  const container = document.body.appendChild(document.createElement('div'));
  const onChange = vi.fn();
  host = new EditorHost(container,{onChange, onMetrics:(id,m) => latest.set(id,m)});
  host.add('a',text,path); host.activate('a'); host.focus();
  const view = EditorView.findFromDOM(container.querySelector('.cm-editor')!)!;
  return {view,host,onChange};
}
function key(view: EditorView, name: string, shiftKey = false) {
  return runScopeHandlers(view, new KeyboardEvent('keydown',{key:name,shiftKey}), 'editor');
}

describe('editing integration', () => {
  it('focuses the document and supports Unicode insertion, undo, redo and independent tab history', async () => {
    const {host,view,onChange} = setup();
    expect(document.activeElement).toBe(view.contentDOM);
    view.dispatch(view.state.replaceSelection('🌷\ncat'));
    expect(latest.get('a')).toMatchObject({line:2,column:4,characters:5});
    host.add('b','two'); host.activate('b');
    expect(view.state.doc.toString()).toBe('two');
    host.activate('a'); await host.command('undo');
    expect(host.text('a')).toBe('');
    expect(host.text('b')).toBe('two');
    await host.command('redo'); expect(host.text('a')).toBe('🌷\ncat');
    expect(onChange).toHaveBeenCalledTimes(3);
  });
  it('identifies unsaved code, respects a manual override and can return to automatic mode', async () => {
    const {host,view} = setup();
    view.dispatch(view.state.replaceSelection('def sample():\n    return 1'));
    await vi.waitFor(() => expect(latest.get('a')?.language).toBe('Python'));
    expect(latest.get('a')?.wrapped).toBe(false);
    host.language('a','Plain Text');
    view.dispatch(view.state.replaceSelection('\nprint("hi")'));
    expect(latest.get('a')).toMatchObject({language:'Plain Text',manualLanguage:'Plain Text',wrapped:true});
    host.language('a',null);
    expect(latest.get('a')?.language).toBe('Python');
  });
  it('uses Tab for indentation on an empty line and accepts a selected completion', async () => {
    const {host,view} = setup('','sample.py');
    expect(key(view,'Tab')).toBe(true); expect(host.text('a')).toBe('    ');
    view.dispatch(view.state.replaceSelection('ret'));
    startCompletion(view);
    await vi.waitFor(() => expect(selectedCompletion(view.state)?.label).toBe('return'));
    key(view,'Tab'); expect(host.text('a')).toBe('    return');
  });
  it('offers defined symbols and words in the document', () => {
    const {view} = setup('def print_receipt():\n    pass\n# printable\npri','file.py');
    const result = localCompletions('Python')(new CompletionContext(view.state,view.state.doc.length,false));
    expect(result?.options).toEqual(expect.arrayContaining([
      expect.objectContaining({label:'print_receipt',type:'function'}),
      expect.objectContaining({label:'printable'}), expect.objectContaining({label:'print',type:'keyword'}),
    ]));
  });
  it('preserves detected indentation, shows guides, and respects separate assistance controls', () => {
    const {host,view} = setup('function f() {\n  const x = 1;\n}','file.js');
    expect(getIndentUnit(view.state)).toBe(2);
    expect(view.dom.querySelector('.cm-indent-guides')).not.toBeNull();
    view.dispatch({selection:{anchor:view.state.doc.length}});
    host.configure({...defaultEditorOptions,closeBrackets:false});
    expect(insertBracket(view.state,'(')).toBeNull();
    expect(insertBracket(view.state,'"')).not.toBeNull();
    host.configure({...defaultEditorOptions,closeQuotes:false});
    expect(insertBracket(view.state,'(')).not.toBeNull();
    expect(insertBracket(view.state,'"')).toBeNull();
    host.configure({...defaultEditorOptions,assistance:false});
    expect(view.dom.querySelector('.cm-lineNumbers')).not.toBeNull();
    expect(view.dom.querySelector('.cm-indent-guides')).not.toBeNull();
    expect(ensureSyntaxTree(view.state,view.state.doc.length,150)?.length).toBe(view.state.doc.length);
    expect(host.text('a')).toContain('  const x');
  });
  it('supports search, case/whole-word replace-all and go-to-line', async () => {
    const {host,view} = setup('cat Cat scatter\ncat');
    await host.command('find');
    const input = (name: string) => view.dom.querySelector<HTMLInputElement>(`input[name="${name}"]`)!;
    input('search').value = 'cat'; input('search').dispatchEvent(new Event('change'));
    input('case').click(); input('word').click();
    await host.command('replace');
    expect(document.activeElement).toBe(input('replace'));
    input('replace').value = 'kit'; input('replace').dispatchEvent(new Event('change'));
    view.dom.querySelector<HTMLButtonElement>('button[name=replaceAll]')!.click();
    expect(host.text('a')).toBe('kit Cat scatter\nkit');
    view.dom.querySelector<HTMLButtonElement>('button[name=close]')!.click();
    await host.command('goToLine');
    input('line').value = '2';
    view.dom.querySelector<HTMLFormElement>('.cm-goto-line')!.dispatchEvent(new Event('submit',{cancelable:true}));
    expect(latest.get('a')).toMatchObject({line:2,column:1});
    expect(view.dom.querySelector('.cm-goto-line')).toBeNull();
  });
  it('retains large document editing and omits completion work above the threshold', () => {
    const text = 'row value\n'.repeat(110000);
    const {view,host} = setup(text,'large.log');
    expect(startCompletion(view)).toBe(false);
    view.dispatch({changes:{from:0,insert:'🌳'}});
    expect(latest.get('a')?.characters).toBe(text.length + 1);
    expect(host.text('a').slice(0,5)).toBe('🌳row');
  });
  it('selects every search match and preserves each selection through menu cut and paste', async () => {
    const {host,view} = setup('cat Cat catalog');
    await host.command('find');
    const search = view.dom.querySelector<HTMLInputElement>('input[name=search]')!;
    search.value = 'cat'; search.dispatchEvent(new Event('change'));
    view.dom.querySelector<HTMLButtonElement>('button[name=select]')!.click();
    expect(view.state.selection.ranges).toHaveLength(3);
    let copied = '';
    const clipboard = {writeText: async (text: string) => { copied = text }, readText: async () => copied};
    Object.defineProperty(navigator, 'clipboard', {configurable: true, value: clipboard});
    try {
      await host.command('copy');
      expect(copied).toBe('cat\nCat\ncat');
      await host.command('cut');
      expect(host.text('a')).toBe('  alog');
      await host.command('paste');
      expect(host.text('a')).toBe('cat Cat catalog');
    } finally {
      Reflect.deleteProperty(navigator, 'clipboard');
    }
  });
  it('keeps manual wrapping per document, and reload resets history', async () => {
    const {host,view} = setup('original','a.txt');
    host.wrap('a',false);
    expect(latest.get('a')?.wrapped).toBe(false);
    view.dispatch({selection:EditorSelection.cursor(8),changes:{from:8,insert:'!'}});
    host.replace('a','on disk','a.txt'); await host.command('undo');
    expect(host.text('a')).toBe('on disk');
  });
});
