import { EditorSelection, EditorState, Compartment, Prec, countColumn, type Extension } from '@codemirror/state';
import { EditorView, drawSelection, keymap, lineNumbers, type ViewUpdate } from '@codemirror/view';
import {
  history, historyKeymap, defaultKeymap, undo, redo, selectAll, indentMore, indentLess, insertNewlineKeepIndent
} from '@codemirror/commands';
import { bracketMatching, indentOnInput, indentUnit } from '@codemirror/language';
import { openSearchPanel, search, searchKeymap } from '@codemirror/search';
import { selectedCompletion, acceptCompletion, autocompletion, closeBrackets, closeBracketsKeymap } from '@codemirror/autocomplete';
import { invoke, isTauri } from '@tauri-apps/api/core';
import { grammar } from './grammars';
import { detectLanguage, filenameLanguage, inferIndentation, languageNames, type Indentation } from './languages';
import { appearance, cursorLocation, indentationGuides, characterCount } from './presentation';
import { localCompletions } from './assistance';
import { goToLine, linePanel } from './line-panel';

export { languageNames };
export interface EditorOptions {
  theme: 'light' | 'dark'; highContrast: boolean; fontSize: number; lineSpacing: number;
  indentWidth: number; useTabs: boolean; wrapText: boolean; wrapCode: boolean;
  assistance: boolean; suggestions: boolean; closeBrackets: boolean; closeQuotes: boolean;
  matchBrackets: boolean; smartIndent: boolean;
}
export const defaultEditorOptions: EditorOptions = {
  theme:'light', highContrast:false, fontSize:14, lineSpacing:1.5, indentWidth:4, useTabs:false,
  wrapText:true, wrapCode:false, assistance:true, suggestions:true, closeBrackets:true, closeQuotes:true,
  matchBrackets:true, smartIndent:true,
};
export interface EditorMetrics {
  line: number; column: number; characters: number; language: string; manualLanguage: string | null; wrapped: boolean;
}
type EditorCommand = 'undo'|'redo'|'selectAll'|'cut'|'copy'|'paste'|'find'|'replace'|'goToLine';
interface Callbacks {
  onChange(id: string): void;
  onMetrics(id: string, metrics: EditorMetrics): void;
}
interface Buffer {
  id: string; filename: string | null; manual: string | null; mode: string; wrap: boolean | null;
  indentation: Indentation | null; large: boolean; state: EditorState;
  scroll?: ReturnType<EditorView['scrollSnapshot']>; timer?: ReturnType<typeof setTimeout>;
}
const LARGE = 1024 * 1024;

function tab(view: EditorView): boolean {
  if (selectedCompletion(view.state) && acceptCompletion(view)) return true;
  const {state} = view;
  if (state.selection.ranges.some(range => !range.empty)) return indentMore(view);
  const unit = state.facet(indentUnit);
  const change = state.changeByRange(range => {
    let padding = unit;
    if (unit !== '\t') {
      const line = state.doc.lineAt(range.head);
      const column = countColumn(state.sliceDoc(line.from,range.head), state.tabSize);
      padding = ' '.repeat(unit.length - column % unit.length);
    }
    return {changes:{from:range.head, insert:padding}, range:EditorSelection.cursor(range.head + padding.length)};
  });
  view.dispatch({...change, scrollIntoView:true, userEvent:'input'});
  return true;
}

export class EditorHost {
  private view: EditorView;
  private buffers = new Map<string, Buffer>();
  private active: Buffer | null = null;
  private options = {...defaultEditorOptions};
  private settings = new Compartment();
  private theme = appearance(false,false,this.options.fontSize,this.options.lineSpacing);

  constructor(parent: HTMLElement, private callbacks: Callbacks) {
    this.view = new EditorView({parent});
  }

  private isWrapped(buffer: Pick<Buffer, 'wrap'|'mode'>) {
    return buffer.wrap ?? (buffer.mode === 'Plain Text' || buffer.mode === 'Markdown' ? this.options.wrapText : this.options.wrapCode);
  }
  private extensions(buffer: Omit<Buffer, 'state'>): Extension[] {
    const o = this.options;
    const width = buffer.indentation?.width ?? o.indentWidth;
    const tabs = buffer.indentation?.tabs ?? o.useTabs;
    const help = o.assistance && !buffer.large;
    const brackets = [...(o.closeBrackets ? ['(','[','{'] : []), ...(o.closeQuotes ? ["'",'"','`'] : [])];
    const extension: Extension[] = [
      grammar(buffer.mode), this.theme,
      indentUnit.of(tabs ? '\t' : ' '.repeat(width)), EditorState.tabSize.of(width),
    ];
    if (this.isWrapped(buffer)) extension.push(EditorView.lineWrapping);
    if (help && o.suggestions) extension.push(autocompletion({
      override:[localCompletions(buffer.mode)], interactionDelay:0, maxRenderedOptions:32,
    }));
    if (help && brackets.length) extension.push(
      Prec.highest(EditorState.languageData.of(() => [{closeBrackets:{brackets}}])),
      closeBrackets(), Prec.high(keymap.of(closeBracketsKeymap)),
    );
    if (help && o.matchBrackets) extension.push(bracketMatching());
    if (help && o.smartIndent) extension.push(indentOnInput());
    else extension.push(Prec.high(keymap.of([{key:'Enter', run:insertNewlineKeepIndent}])));
    return extension;
  }

  private makeBuffer(id: string, text: string, filename: string | null, old?: Buffer): Buffer {
    const manual = old?.manual ?? null;
    const base = {
      id,filename,manual,mode:manual ?? detectLanguage(text,filename),wrap:old?.wrap ?? null,
      indentation:filename ? inferIndentation(text) : null, large:text.length > LARGE,
    };
    const state = EditorState.create({doc:text, extensions:[
      this.settings.of(this.extensions(base)), lineNumbers(), history(), search({top:true}), linePanel, characterCount, indentationGuides,
      EditorState.allowMultipleSelections.of(true), drawSelection(),
      EditorView.contentAttributes.of({'aria-label':'Document text',spellcheck:'false',autocapitalize:'off',autocorrect:'off'}),
      Prec.high(keymap.of([{key:'Tab', run:tab, shift:indentLess}, {key:'Mod-g', run:goToLine}])),
      keymap.of([...defaultKeymap,...historyKeymap,...searchKeymap.filter(binding => binding.key !== 'Mod-g' && binding.key !== 'Mod-Alt-g')]),
      EditorView.updateListener.of(u => this.changed(u)),
    ]});
    return {...base,state};
  }

  add(id: string, text: string, filename: string | null = null) {
    this.buffers.set(id,this.makeBuffer(id,text,filename));
  }
  activate(id: string) {
    const next = this.buffers.get(id);
    if (!next) return;
    if (this.active !== next) {
      if (this.active) this.active.scroll = this.view.scrollSnapshot();
      this.active = next;
      this.view.setState(next.state);
      if (next.scroll) this.view.dispatch({effects:next.scroll});
      else { this.view.scrollDOM.scrollLeft = 0; this.view.scrollDOM.scrollTop = 0; }
    }
    this.emit(next);
  }
  remove(id: string) {
    const buffer = this.buffers.get(id);
    clearTimeout(buffer?.timer);
    if (buffer === this.active) this.active = null;
    this.buffers.delete(id);
  }
  replace(id: string, text: string, filename?: string | null) {
    const old = this.buffers.get(id);
    if (!old) return;
    clearTimeout(old.timer);
    const next = this.makeBuffer(id,text,filename === undefined ? old.filename : filename,old);
    this.buffers.set(id,next);
    if (this.active === old) { this.active = null; this.activate(id); }
    else this.emit(next);
  }
  rename(id: string, filename: string | null) {
    const buffer = this.buffers.get(id);
    if (!buffer) return;
    buffer.filename = filename;
    this.identify(buffer);
  }
  text(id: string) { return this.buffers.get(id)?.state.doc.toString() ?? ''; }
  language(id: string, manual: string | null) {
    const buffer = this.buffers.get(id);
    if (!buffer || (manual && !languageNames.includes(manual))) return;
    buffer.manual = manual;
    // Re-enable detection without carrying the old manual choice into ambiguous text.
    this.identify(buffer,'Plain Text');
  }
  wrap(id: string, override: boolean | null) {
    const buffer = this.buffers.get(id);
    if (buffer) { buffer.wrap = override; this.apply(buffer); }
  }
  configure(options: EditorOptions) {
    const keys = Object.keys(defaultEditorOptions) as (keyof EditorOptions)[];
    if (keys.every(key => options[key] === this.options[key])) return;
    const changeIndent = options.useTabs !== this.options.useTabs || options.indentWidth !== this.options.indentWidth;
    if (options.theme !== this.options.theme || options.highContrast !== this.options.highContrast ||
        options.fontSize !== this.options.fontSize || options.lineSpacing !== this.options.lineSpacing) {
      this.theme = appearance(options.theme === 'dark',options.highContrast,options.fontSize,options.lineSpacing);
    }
    this.options = {...options};
    for (const buffer of this.buffers.values()) {
      if (changeIndent) buffer.indentation = null;
      this.apply(buffer);
    }
  }
  private apply(buffer: Buffer) {
    const transaction = buffer.state.update({effects:this.settings.reconfigure(this.extensions(buffer))});
    if (this.active === buffer) this.view.dispatch(transaction);
    else buffer.state = transaction.state;
    this.emit(buffer);
  }
  private identify(buffer: Buffer, previous = buffer.mode) {
    buffer.mode = buffer.manual ?? detectLanguage(buffer.state.sliceDoc(0,Math.min(12288,buffer.state.doc.length)),buffer.filename,previous);
    this.apply(buffer);
  }
  private changed(update: ViewUpdate) {
    const buffer = this.active;
    if (!buffer) return;
    buffer.state = update.state;
    if (update.docChanged) {
      this.callbacks.onChange(buffer.id);
      const detect = !buffer.manual && !filenameLanguage(buffer.filename);
      if (detect || (buffer.state.doc.length > LARGE) !== buffer.large) {
        clearTimeout(buffer.timer);
        buffer.timer = setTimeout(() => {
          const large = buffer.state.doc.length > LARGE;
          const mode = buffer.manual ?? detectLanguage(buffer.state.sliceDoc(0,Math.min(buffer.state.doc.length,12288)),buffer.filename,buffer.mode);
          if (mode !== buffer.mode || large !== buffer.large) {
            buffer.mode = mode; buffer.large = large; this.apply(buffer);
          }
        },220);
      }
    }
    if (update.docChanged || update.selectionSet) this.emit(buffer);
  }
  private emit(buffer: Buffer) {
    this.callbacks.onMetrics(buffer.id,{...cursorLocation(buffer.state),characters:buffer.state.field(characterCount),
      language:buffer.mode,manualLanguage:buffer.manual,wrapped:this.isWrapped(buffer)});
  }
  focus() { this.view.focus(); }

  async command(command: EditorCommand) {
    const buffer = this.active;
    if (!buffer) return;
    const view = this.view;
    this.focus();
    switch (command) {
      case 'undo': undo(view); return;
      case 'redo': redo(view); return;
      case 'selectAll': selectAll(view); return;
      case 'goToLine': goToLine(view); return;
      case 'find': openSearchPanel(view); return;
      case 'replace':
        openSearchPanel(view);
        view.dom.querySelector<HTMLInputElement>('.cm-panel input[name=replace]')?.focus();
        return;
    }
    const before = view.state;
    const sameSelection = () => this.active === buffer && view.state.doc === before.doc && view.state.selection.eq(before.selection);
    if (command === 'paste') {
      const text = isTauri() ? await invoke<string>('read_clipboard') : await navigator.clipboard.readText();
      if (!text || !sameSelection()) return;
      const content = before.toText(text);
      let line = 1;
      const changes = before.selection.ranges.length > 1 && content.lines === before.selection.ranges.length
        ? before.changeByRange(range => {
            const part = content.line(line++);
            return {changes:{from:range.from,to:range.to,insert:part.text},range:EditorSelection.cursor(range.from + part.length)};
          })
        : before.replaceSelection(content);
      view.dispatch({...changes,userEvent:'input.paste',scrollIntoView:true});
      return;
    }
    const ranges = before.selection.ranges.filter(range => !range.empty);
    if (!ranges.length) return;
    const text = ranges.map(range => before.sliceDoc(range.from,range.to)).join(before.lineBreak);
    if (isTauri()) await invoke('write_clipboard',{text});
    else await navigator.clipboard.writeText(text);
    if (command === 'cut' && sameSelection())
      view.dispatch({...before.replaceSelection(''), userEvent:'delete.cut',scrollIntoView:true});
  }
  destroy() {
    for (const buffer of this.buffers.values()) clearTimeout(buffer.timer);
    this.active = null;
    this.buffers.clear();
    this.view.destroy();
  }
}
