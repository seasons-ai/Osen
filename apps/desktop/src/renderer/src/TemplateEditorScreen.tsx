import { useReducer, useState } from "react";
import type { ReactNode } from "react";
import type { TemplateEditorData, TemplateFieldIssue } from "../../shared/setup.ts";
import { TemplateEditor } from "./TemplateEditor.tsx";
import { initialEditor, reduceEditor, toDraft } from "./template-editor.ts";
import type { EditorForm } from "./template-editor.ts";

export function TemplateEditorScreen({ data, initial, backLabel, onDone }: {
  data: TemplateEditorData;
  initial?: EditorForm;
  backLabel: string;
  onDone(savedId: string | null): void;
}): ReactNode {
  const [form, dispatch] = useReducer(reduceEditor, undefined, () => initial ?? initialEditor(data));
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [issues, setIssues] = useState<TemplateFieldIssue[]>([]);
  const onSave = () => {
    if (saving) return;
    setSaving(true);
    setError(null);
    setIssues([]);
    const draft = toDraft(form);
    const run = data.id === null ? window.council.createTemplate(draft) : window.council.saveTemplate(data.id, draft);
    run.then(
      (r) => {
        if (r.ok) { onDone(r.id); return; }
        setError(r.error);
        setIssues(r.issues);
        setSaving(false);
      },
      (e) => {
        setError(e instanceof Error ? e.message : String(e));
        setSaving(false);
      },
    );
  };
  return <TemplateEditor data={data} form={form} saving={saving} error={error} issues={issues} backLabel={backLabel} dispatch={dispatch} onSave={onSave} onCancel={() => onDone(null)} />;
}
