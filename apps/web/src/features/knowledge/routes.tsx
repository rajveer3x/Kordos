import { Link, Route, Routes } from "react-router";
import { AsyncState } from "../../components/ui";
import { DecisionEditor, DecisionPage, Decisions } from "./decisions";
import { DocumentEditor, DocumentPage, Documents } from "./documents";
import { EvidencePage } from "./evidence";
import { useKnowledge } from "./knowledge-client";

export default function ProjectKnowledge() {
  const { base } = useKnowledge();
  return (
    <Routes>
      <Route index element={<Documents />} />
      <Route path="new" element={<DocumentEditor />} />
      <Route path=":documentId" element={<DocumentPage />} />
      <Route
        path=":documentId/revisions/:revision"
        element={<DocumentPage />}
      />
      <Route path="evidence/:kind/:sourceId" element={<EvidencePage />} />
      <Route path="decisions" element={<Decisions />} />
      <Route path="decisions/new" element={<DecisionEditor />} />
      <Route path="decisions/:decisionId" element={<DecisionPage />} />
      <Route path="decisions/:decisionId/edit" element={<DecisionEditor />} />
      <Route
        path="*"
        element={
          <section className="planning-panel glass-panel knowledge-panel">
            <AsyncState kind="error" message="This page is unavailable." />
            <Link to={base}>All documents</Link>
          </section>
        }
      />
    </Routes>
  );
}
