import { StateField, type EditorState, type Range } from '@codemirror/state';
import { EditorView, ViewPlugin, Decoration, type DecorationSet, type ViewUpdate } from '@codemirror/view';
import { HighlightStyle, syntaxHighlighting } from '@codemirror/language';
import { tags } from '@lezer/highlight';

function pairs(text: string): number {
  let count = 0;
  const pair = /[\uD800-\uDBFF][\uDC00-\uDFFF]/g;
  while (pair.test(text)) count++;
  return count;
}
export function codePoints(text: string) { return text.length - pairs(text); }

// Include one UTF-16 unit on either side of each edit so that editing one
// half of a surrogate pair is equivalent to recounting the whole document.
export const characterCount = StateField.define<number>({
  create(state) {
    let count = state.doc.length;
    for (const chunk of state.doc) count -= pairs(chunk);
    return count;
  },
  update(count, tr) {
    if (!tr.docChanged) return count;
    let changedPairs = 0;
    tr.changes.iterChangedRanges((a, b, c, d) => {
      changedPairs += pairs(tr.startState.sliceDoc(Math.max(0,a - 1), Math.min(tr.startState.doc.length,b + 1)));
      changedPairs -= pairs(tr.newDoc.sliceString(Math.max(0,c - 1), Math.min(tr.newDoc.length,d + 1)));
    });
    return count + tr.newDoc.length - tr.startState.doc.length + changedPairs;
  }
});

function visibleGuides(view: EditorView): DecorationSet {
  const lines: Range<Decoration>[] = [];
  let lastLine = -1;
  const width = view.state.tabSize;
  for (const range of view.visibleRanges) {
    let pos = range.from;
    while (pos <= range.to) {
      const line = view.state.doc.lineAt(pos);
      if (line.from !== lastLine) {
        const prefix = view.state.sliceDoc(line.from, Math.min(line.to, line.from + 512));
        let columns = 0;
        for (const ch of prefix) {
          if (ch === ' ') columns++;
          else if (ch === '\t') columns += width - columns % width;
          else break;
        }
        if (columns >= width) {
          lines.push(Decoration.line({class:'cm-indent-guides', attributes:{
            style: `--guide-width:${width}ch;--guide-span:${Math.floor(columns / width) * width}ch`
          }}).range(line.from));
        }
        lastLine = line.from;
      }
      pos = line.to + 1;
    }
  }
  return Decoration.set(lines);
}
export const indentationGuides = ViewPlugin.fromClass(class {
  decorations: DecorationSet;
  constructor(view: EditorView) { this.decorations = visibleGuides(view); }
  update(update: ViewUpdate) {
    if (update.docChanged || update.viewportChanged || update.startState.tabSize !== update.state.tabSize)
      this.decorations = visibleGuides(update.view);
  }
}, {decorations: value => value.decorations});

export function appearance(dark: boolean, contrast: boolean, size: number, lineSpacing: number) {
  const paper = dark ? (contrast ? '#000' : '#202123') : '#fff';
  const ink = dark ? (contrast ? '#fff' : '#dedfe2') : (contrast ? '#000' : '#252629');
  const muted = dark ? (contrast ? '#d3d4d6' : '#95989e') : (contrast ? '#3a3b3f' : '#75777d');
  const edge = dark ? (contrast ? '#ddd' : '#383a3e') : (contrast ? '#252629' : '#ebebed');
  const selected = dark ? '#394e69' : '#d6e4f7';
  const ui = dark ? '#292a2d' : '#f7f7f8';
  const theme = EditorView.theme({
    '&': {height:'100%', color:ink, backgroundColor:paper, fontSize: `${size}px`},
    '&.cm-focused': {outline:'none'},
    '.cm-scroller': {overflow:'auto', fontFamily:'"DejaVu Sans Mono", Consolas, "Liberation Mono", monospace', lineHeight:String(lineSpacing)},
    '.cm-content': {padding:'8px 0', caretColor:ink, minHeight:'100%'},
    '.cm-line': {padding:'0 5px 0 8px'},
    '.cm-gutters': {backgroundColor:paper, color:muted, borderRight:`1px solid ${edge}`, userSelect:'none'},
    '.cm-lineNumbers .cm-gutterElement': {padding:'0 7px', minWidth:'2.7ch', textAlign:'right'},
    '.cm-indent-guides': {
      backgroundImage:`repeating-linear-gradient(to right, ${edge} 0px, ${edge} 1px, transparent 1px, transparent var(--guide-width))`,
      backgroundPosition:'8px 0',backgroundSize:'var(--guide-span) 100%',backgroundRepeat:'no-repeat'
    },
    '&.cm-focused .cm-selectionBackground, .cm-selectionBackground, .cm-content ::selection': {backgroundColor:selected},
    '.cm-cursor, .cm-dropCursor': {borderLeftColor:ink},
    '&.cm-focused .cm-matchingBracket': {backgroundColor:selected, outline:`1px solid ${muted}`},
    '.cm-panels, .cm-tooltip': {backgroundColor:ui, color:ink, borderColor:edge, fontFamily:'system-ui, sans-serif', fontSize:'0.86rem'},
    '.cm-panels.cm-panels-top': {borderBottom:`1px solid ${edge}`},
    '.cm-goto-line': {display:'flex', alignItems:'center', gap:'5px', padding:'4px 8px'},
    '.cm-goto-line input': {width:'7em'},
    '.cm-panel input, .cm-panel button': {font:'inherit', color:ink},
    '.cm-panel .cm-textfield, .cm-panel .cm-button': {background:paper, border:`1px solid ${muted}`, borderRadius:'3px', padding:'2px 5px'},
    '.cm-panel input:focus-visible, .cm-panel button:focus-visible': {outline:`2px solid ${dark ? '#a9c9f3' : '#496b98'}`, outlineOffset:'1px'},
    '.cm-tooltip-autocomplete ul li[aria-selected]': {backgroundColor:selected, color:ink},
    '.cm-searchMatch': {backgroundColor:dark ? '#655638' : '#f4e6aa'},
    '.cm-searchMatch.cm-searchMatch-selected': {backgroundColor:dark ? '#806832' : '#edce65'},
  }, {dark});
  const style = HighlightStyle.define([
    {tag:tags.keyword, color:dark ? '#c6abdf' : '#78438a', fontWeight:contrast ? 'bold' : 'normal'},
    {tag:[tags.string,tags.special(tags.string),tags.regexp,tags.url], color:dark ? '#add0a5' : '#3f6b43'},
    {tag:tags.comment, color:muted, fontStyle:'italic'},
    {tag:[tags.number,tags.bool,tags.null,tags.atom], color:dark ? '#dfad90' : '#904d29'},
    {tag:[tags.function(tags.variableName),tags.function(tags.propertyName)], color:dark ? '#a4c6eb' : '#345e87'},
    {tag:[tags.typeName,tags.className,tags.tagName], color:dark ? '#8fc8c5' : '#28676c'},
    {tag:[tags.propertyName,tags.attributeName], color:dark ? '#c3b9dc' : '#654981'},
    {tag:[tags.operator,tags.punctuation], color:dark ? '#bbbcc1' : '#53565e'},
    {tag:[tags.variableName,tags.name], color:ink},
    {tag:tags.heading, color:dark ? '#cad7e8' : '#394f6b', fontWeight:'bold'},
    {tag:tags.strong, fontWeight:'bold'}, {tag:tags.emphasis,fontStyle:'italic'},
    {tag:tags.link,color:dark ? '#a4c6eb' : '#345e87', textDecoration:'underline'},
  ]);
  return [theme, syntaxHighlighting(style)];
}

export function cursorLocation(state: EditorState) {
  const pos = state.selection.main.head;
  const line = state.doc.lineAt(pos);
  return {line:line.number, column:codePoints(state.sliceDoc(line.from,pos)) + 1};
}
