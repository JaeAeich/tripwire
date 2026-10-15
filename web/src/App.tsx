import { Link, Route, Routes, useLocation } from "react-router-dom";
import { useEffect } from "react";
import { Layout } from "./components/Layout";
import { ErrorBoundary } from "./components/ErrorBoundary";
import { Home, RunsIndex } from "./pages/Home";
import { NewCheck } from "./pages/NewCheck";
import { EditRedirect, ReviewDraft } from "./pages/ReviewDraft";
import { RunPage } from "./pages/RunPage";
import { TrialPage } from "./pages/TrialPage";
import { ComparePage } from "./pages/ComparePage";
import { ProjectMap, ProjectRuns, ProjectSetup, ProjectTests, ScenariosIndex } from "./pages/ScenarioPage";
import { ProjectOverview, ProjectPrompt, PromisePage, RunCompare, TestPage } from "./pages/Project";
import { ProjectFix } from "./pages/Loop";
import { ProjectAttack } from "./pages/Attack";

function ScrollTop() {
  const { pathname } = useLocation();
  useEffect(() => {
    window.scrollTo(0, 0);
  }, [pathname]);
  return null;
}

export function App() {
  const { pathname } = useLocation();
  return (
    <Layout>
      <ScrollTop />
      <ErrorBoundary resetKey={pathname}>
        <Routes>
          <Route path="/" element={<Home />} />
          <Route path="/check" element={<NewCheck />} />
          <Route path="/check/review" element={<ReviewDraft />} />
          <Route path="/runs" element={<RunsIndex />} />
          <Route path="/scenarios" element={<ScenariosIndex />} />
          <Route path="/scenarios/:name" element={<ProjectOverview />} />
          <Route path="/scenarios/:name/prompt" element={<ProjectPrompt />} />
          <Route path="/scenarios/:name/promises/:rule" element={<PromisePage />} />
          <Route path="/scenarios/:name/tests/:test" element={<TestPage />} />
          <Route path="/scenarios/:name/tests" element={<ProjectTests />} />
          <Route path="/scenarios/:name/runs" element={<ProjectRuns />} />
          <Route path="/scenarios/:name/map" element={<ProjectMap />} />
          <Route path="/scenarios/:name/attack" element={<ProjectAttack />} />
          <Route path="/scenarios/:name/fix" element={<ProjectFix />} />
          <Route path="/scenarios/:name/setup" element={<ProjectSetup />} />
          <Route path="/scenarios/:name/edit" element={<EditRedirect />} />
          <Route path="/runs/:id" element={<RunPage />} />
          <Route path="/runs/:id/t/:variant/:caseId/:n" element={<TrialPage />} />
          <Route path="/runs/:id/compare/:section/:rule" element={<ComparePage />} />
          <Route path="/runs/:id/vs/:other" element={<RunCompare />} />
          <Route
            path="*"
            element={
              <div className="view">
                <p className="quiet">
                  Nothing here. <Link to="/">Back to the workspace</Link>
                </p>
              </div>
            }
          />
        </Routes>
      </ErrorBoundary>
    </Layout>
  );
}
