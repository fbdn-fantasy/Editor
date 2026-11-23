import { StateField, StateEffect } from '@codemirror/state';
import { EditorView, showPanel, type Panel } from '@codemirror/view';

// Keep the input scoped to the active view. Switching documents can destroy
// and recreate a panel without leaving a pending dialog callback behind.
const setVisible = StateEffect.define<boolean>();

function createPanel(view: EditorView): Panel {
  const form = document.createElement('form');
  form.className = 'cm-goto-line';
  const input = document.createElement('input');
  input.name = 'line';
  input.type = 'number';
  input.min = '1';
  input.required = true;
  input.step = '1';
  input.max = String(view.state.doc.lines);
  input.value = String(view.state.doc.lineAt(view.state.selection.main.head).number);
  input.className = 'cm-textfield';
  const label = document.createElement('label');
  label.append('Go to line ', input);
  const go = document.createElement('button');
  go.type = 'submit';
  go.className = 'cm-button';
  go.textContent = 'Go';
  const close = document.createElement('button');
  close.type = 'button';
  close.className = 'cm-button';
  close.setAttribute('aria-label','Close');
  close.textContent = '×';
  function dismiss() {
    view.dispatch({effects:setVisible.of(false)});
    view.focus();
  }
  close.addEventListener('click', dismiss);
  form.addEventListener('keydown', event => {
    if (event.key === 'Escape') { event.preventDefault(); dismiss(); }
  });
  form.addEventListener('submit', event => {
    event.preventDefault();
    if (!input.reportValidity()) return;
    const line = view.state.doc.line(Math.min(view.state.doc.lines, input.valueAsNumber));
    view.dispatch({
      selection: {anchor:line.from},
      effects:[setVisible.of(false), EditorView.scrollIntoView(line.from,{y:'center'})],
      userEvent:'select',
    });
    view.focus();
  });
  form.append(label,go,close);
  return {dom:form,top:true,update(update) {
    if (update.docChanged) input.max = String(update.state.doc.lines);
  }};
}

export const linePanel = StateField.define<boolean>({
  create: () => false,
  update(visible, transaction) {
    for (const effect of transaction.effects) if (effect.is(setVisible)) visible = effect.value;
    return visible;
  },
  provide: field => showPanel.from(field, visible => visible ? createPanel : null),
});

export function goToLine(view: EditorView) {
  view.dispatch({effects:setVisible.of(true)});
  const input = view.dom.querySelector<HTMLInputElement>('.cm-goto-line input');
  input?.focus();
  input?.select();
  return true;
}
