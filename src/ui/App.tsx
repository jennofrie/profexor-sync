import { useCallback, useEffect, useMemo, useState } from "react";
import { useKeyboard, useRenderer } from "@opentui/react";
import type { AppConfig, AuditEvent, ProjectObservation, SyncRun } from "../core/types.ts";
import { RunStatus } from "../core/types.ts";
import type { StateStore } from "../core/state.ts";
import type { SyncEngine } from "../core/engine.ts";
import { errorMessage } from "../core/errors.ts";
import { git } from "../core/git.ts";

type AppProps = {
  config: AppConfig;
  state: StateStore;
  engine: SyncEngine;
};

const tabs = ["Dashboard", "Review", "Diff", "Conflicts", "Checks", "History"] as const;
type Tab = (typeof tabs)[number];

function statusColor(status: string): string {
  if (["promoted", "validated", "ready", "pass"].includes(status)) {
    return "#4ade80";
  }
  if (["conflicts", "validation_failed", "failed", "stale", "fail"].includes(status)) {
    return "#fb7185";
  }
  if (["preparing", "validating", "warn", "pull_request"].includes(status)) {
    return "#facc15";
  }
  return "#94a3b8";
}

function shortSha(sha: string | null): string {
  return sha?.slice(0, 10) ?? "—";
}

function formatTime(timestamp: string): string {
  return new Date(timestamp).toLocaleString();
}

export function App({ config, state, engine }: AppProps) {
  const renderer = useRenderer();
  const [selectedIndex, setSelectedIndex] = useState(0);
  const [activeTab, setActiveTab] = useState<Tab>("Dashboard");
  const [observations, setObservations] = useState<ProjectObservation[]>([]);
  const [runs, setRuns] = useState<SyncRun[]>([]);
  const [events, setEvents] = useState<AuditEvent[]>([]);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState("Ready");
  const [confirmationRun, setConfirmationRun] = useState<SyncRun | null>(null);
  const [confirmationValue, setConfirmationValue] = useState("");
  const [diff, setDiff] = useState("");

  const selectedProject = config.projects[selectedIndex] ?? config.projects[0]!;
  const selectedRun = useMemo(
    () => runs.find((run) => run.projectId === selectedProject.id) ?? null,
    [runs, selectedProject.id],
  );

  const refresh = useCallback(() => {
    setObservations(state.listObservations());
    setRuns(state.listRuns(undefined, 100));
    setEvents(state.listEvents(100));
  }, [state]);

  useEffect(() => {
    refresh();
  }, [refresh]);

  useEffect(() => {
    let cancelled = false;
    if (activeTab !== "Diff" || !selectedRun?.candidateSha) {
      setDiff("");
      return;
    }
    void git(selectedRun.worktreePath, [
      "diff",
      "--find-renames",
      "--no-ext-diff",
      `${selectedRun.destinationBeforeSha}..${selectedRun.candidateSha}`,
    ])
      .then((result) => {
        if (!cancelled) {
          setDiff(result.stdout.slice(0, 1_000_000));
        }
      })
      .catch((error) => {
        if (!cancelled) {
          setDiff(`Unable to load diff: ${errorMessage(error)}`);
        }
      });
    return () => {
      cancelled = true;
    };
  }, [activeTab, selectedRun]);

  const runAction = useCallback(
    async (label: string, action: () => Promise<unknown>) => {
      if (busy) {
        return;
      }
      setBusy(true);
      setMessage(label);
      try {
        await action();
        setMessage(`${label}: complete`);
      } catch (error) {
        setMessage(`${label}: ${errorMessage(error)}`);
      } finally {
        refresh();
        setBusy(false);
      }
    },
    [busy, refresh],
  );

  useKeyboard((key) => {
    if (confirmationRun) {
      if (key.name === "escape") {
        setConfirmationRun(null);
        setConfirmationValue("");
      }
      return;
    }
    if (busy) {
      return;
    }
    if (key.name === "q" || (key.ctrl && key.name === "c")) {
      renderer.destroy();
      return;
    }
    if (key.name === "up") {
      setSelectedIndex((index) => Math.max(0, index - 1));
      return;
    }
    if (key.name === "down") {
      setSelectedIndex((index) => Math.min(config.projects.length - 1, index + 1));
      return;
    }
    if (key.name === "tab") {
      setActiveTab((tab) => tabs[(tabs.indexOf(tab) + 1) % tabs.length] ?? "Dashboard");
      return;
    }
    if (key.name === "r") {
      void runAction("Remote check", () => engine.checkAll());
      return;
    }
    if (key.name === "p") {
      void runAction(`Prepare ${selectedProject.label}`, () =>
        engine.prepare(selectedProject.id),
      );
      return;
    }
    if (key.name === "v" && selectedRun) {
      void runAction(`Validate ${selectedProject.label}`, () =>
        engine.validate(selectedRun.id),
      );
      return;
    }
    if (key.name === "c" && selectedRun?.status === RunStatus.Conflicts) {
      void runAction(`Resolve ${selectedProject.label}`, () =>
        engine.continueAfterConflicts(selectedRun.id, true),
      );
      return;
    }
    if (key.name === "a" && selectedRun) {
      void runAction(`Advisor ${selectedProject.label}`, () =>
        engine.advise(selectedRun.id),
      );
      return;
    }
    if (key.name === "m" && selectedRun?.status === RunStatus.Validated) {
      setConfirmationRun(selectedRun);
      setConfirmationValue("");
      return;
    }
    if (key.name === "d" && selectedRun) {
      void runAction(`Discard ${selectedProject.label}`, () =>
        engine.discard(selectedRun.id),
      );
    }
  });

  const confirmPromotion = useCallback(
    (value: string) => {
      if (!confirmationRun) {
        return;
      }
      const project = config.projects.find(
        (candidate) => candidate.id === confirmationRun.projectId,
      );
      if (!project || value !== project.id) {
        setMessage(`Confirmation must exactly match ${project?.id ?? "the project id"}`);
        return;
      }
      const runId = confirmationRun.id;
      setConfirmationRun(null);
      setConfirmationValue("");
      void runAction(`Promote ${project.label}`, () => engine.promote(runId));
    },
    [config.projects, confirmationRun, engine, runAction],
  );

  if (confirmationRun) {
    return (
      <box
        style={{
          width: "100%",
          height: "100%",
          alignItems: "center",
          justifyContent: "center",
          backgroundColor: "#08111f",
        }}
      >
        <box
          title="Human-controlled promotion"
          style={{
            width: 74,
            height: 13,
            border: true,
            borderColor: "#fb7185",
            flexDirection: "column",
            padding: 1,
          }}
        >
          <text fg="#fb7185">This will fast-forward GitHub main after a final stale-ref check.</text>
          <text fg="#cbd5e1">
            Candidate: {shortSha(confirmationRun.candidateSha)} · Run: {confirmationRun.id}
          </text>
          <text fg="#facc15">Type {confirmationRun.projectId} and press Enter:</text>
          <box style={{ border: true, height: 3, marginTop: 1 }}>
            <input
              focused
              value={confirmationValue}
              placeholder={confirmationRun.projectId}
              onInput={setConfirmationValue}
              onSubmit={confirmPromotion as never}
            />
          </box>
          <text fg="#64748b">Esc cancels. No force-push is available.</text>
        </box>
      </box>
    );
  }

  return (
    <box
      style={{
        width: "100%",
        height: "100%",
        flexDirection: "column",
        backgroundColor: "#08111f",
      }}
    >
      <box
        style={{
          height: 3,
          border: true,
          borderColor: "#22d3ee",
          paddingLeft: 1,
          paddingRight: 1,
          justifyContent: "space-between",
        }}
      >
        <text fg="#22d3ee">
          <strong>PROFEXOR SYNC</strong>
        </text>
        <text fg={busy ? "#facc15" : "#4ade80"}>{busy ? "WORKING" : "REVIEW-FIRST"}</text>
      </box>

      <box style={{ height: 3, paddingLeft: 1, gap: 2 }}>
        {tabs.map((tab) => (
          <text key={tab} fg={activeTab === tab ? "#f8fafc" : "#64748b"}>
            {activeTab === tab ? `[${tab}]` : tab}
          </text>
        ))}
      </box>

      <box style={{ flexGrow: 1, flexDirection: "row", gap: 1 }}>
        <box
          title="Projects"
          style={{
            width: 30,
            border: true,
            borderColor: "#334155",
            flexDirection: "column",
            padding: 1,
          }}
        >
          {config.projects.map((project, index) => {
            const observation = observations.find((item) => item.projectId === project.id);
            const latestRun = runs.find((run) => run.projectId === project.id);
            return (
              <box key={project.id} style={{ flexDirection: "column", marginBottom: 1 }}>
                <text fg={index === selectedIndex ? "#22d3ee" : "#cbd5e1"}>
                  {index === selectedIndex ? "▶ " : "  "}
                  {project.label}
                </text>
                <text fg={observation?.unread ? "#facc15" : "#64748b"}>
                  {"  "}
                  {observation?.unread ? "NEW" : "seen"} · {shortSha(observation?.sourceSha ?? null)}
                </text>
                <text fg={statusColor(latestRun?.status ?? "idle")}>
                  {"  "}
                  {latestRun?.status ?? "idle"}
                </text>
              </box>
            );
          })}
        </box>

        <box
          title={`${activeTab} · ${selectedProject.label}`}
          style={{
            flexGrow: 1,
            border: true,
            borderColor: "#334155",
            flexDirection: "column",
            padding: 1,
          }}
        >
          {activeTab === "Dashboard" && (
            <Dashboard
              observation={observations.find((item) => item.projectId === selectedProject.id)}
              run={selectedRun}
              projectPath={selectedProject.path}
            />
          )}
          {activeTab === "Review" && <Review run={selectedRun} />}
          {activeTab === "Diff" &&
            (diff ? (
              <diff
                diff={diff}
                view="unified"
                showLineNumbers
                wrapMode="none"
                style={{ flexGrow: 1 }}
              />
            ) : (
              <text fg="#64748b">No candidate diff available.</text>
            ))}
          {activeTab === "Conflicts" && <Conflicts run={selectedRun} />}
          {activeTab === "Checks" && <Checks run={selectedRun} />}
          {activeTab === "History" && (
            <History
              events={events.filter(
                (event) => event.projectId === null || event.projectId === selectedProject.id,
              )}
            />
          )}
        </box>
      </box>

      <box
        style={{
          height: 4,
          border: true,
          borderColor: "#334155",
          flexDirection: "column",
          paddingLeft: 1,
        }}
      >
        <text fg={message.includes(": ") ? "#facc15" : "#94a3b8"}>{message}</text>
        <text fg="#64748b">
          ↑↓ project · Tab view · r check · p prepare · v validate · c Mergiraf/continue · a Advisor · m promote · d discard · q quit
        </text>
      </box>
    </box>
  );
}

function Dashboard({
  observation,
  run,
  projectPath,
}: {
  observation?: ProjectObservation;
  run: SyncRun | null;
  projectPath: string;
}) {
  return (
    <box style={{ flexDirection: "column", gap: 1 }}>
      <text fg="#94a3b8">Path: {projectPath}</text>
      <text fg="#cbd5e1">Last check: {observation ? formatTime(observation.checkedAt) : "never"}</text>
      <text fg="#cbd5e1">Source: {shortSha(observation?.sourceSha ?? null)}</text>
      <text fg="#cbd5e1">Destination: {shortSha(observation?.destinationSha ?? null)}</text>
      <text fg={observation?.unread ? "#facc15" : "#4ade80"}>
        {observation?.unread ? "Incoming commits detected" : "No unread update"}
      </text>
      {run ? (
        <>
          <text fg={statusColor(run.status)}>Latest run: {run.status}</text>
          <text fg="#cbd5e1">Candidate: {shortSha(run.candidateSha)}</text>
          <text fg="#cbd5e1">Incoming commits: {run.commits.length}</text>
          <text fg="#cbd5e1">Worktree: {run.worktreePath}</text>
        </>
      ) : (
        <text fg="#64748b">No candidate run.</text>
      )}
    </box>
  );
}

function Review({ run }: { run: SyncRun | null }) {
  if (!run) {
    return <text fg="#64748b">Prepare an update to review its commits and risk profile.</text>;
  }
  return (
    <scrollbox style={{ flexGrow: 1, flexDirection: "column" }}>
      <text fg="#22d3ee">Incoming commits ({run.commits.length})</text>
      {run.commits.map((commit) => (
        <text key={commit.sha} fg="#cbd5e1">
          {commit.shortSha} · {commit.author} · {commit.subject}
        </text>
      ))}
      <text fg="#22d3ee">Risk signals ({run.risks.length})</text>
      {run.risks.map((risk, index) => (
        <text key={`${risk.category}-${index}`} fg={statusColor(risk.level === "high" ? "fail" : risk.level === "medium" ? "warn" : "pass")}>
          {risk.level.toUpperCase()} · {risk.message}
        </text>
      ))}
      {run.advisorResponse && (
        <>
          <text fg="#22d3ee">Advisor</text>
          <text fg="#cbd5e1">{run.advisorResponse.summary}</text>
        </>
      )}
    </scrollbox>
  );
}

function Conflicts({ run }: { run: SyncRun | null }) {
  if (!run || run.conflicts.length === 0) {
    return <text fg="#4ade80">No active conflicts.</text>;
  }
  return (
    <box style={{ flexDirection: "column" }}>
      <text fg="#fb7185">{run.conflicts.length} unresolved conflict(s)</text>
      {run.conflicts.map((path) => (
        <text key={path} fg="#facc15">{path}</text>
      ))}
      <text fg="#94a3b8">Edit only inside: {run.worktreePath}</text>
      <text fg="#64748b">Press c to run Mergiraf and continue; every resulting diff remains reviewable.</text>
    </box>
  );
}

function Checks({ run }: { run: SyncRun | null }) {
  if (!run) {
    return <text fg="#64748b">No validation run.</text>;
  }
  return (
    <box style={{ flexDirection: "column", gap: 1 }}>
      <text fg={statusColor(run.status)}>Status: {run.status}</text>
      <text fg="#cbd5e1">Validated SHA: {shortSha(run.validatedCandidateSha)}</text>
      <text fg="#cbd5e1">Image: {run.validatorImage ?? "not run"}</text>
      <text fg={run.error ? "#fb7185" : "#64748b"}>{run.error ?? "No validation error recorded."}</text>
      <text fg="#94a3b8">Full sanitized log: ~/.local/state/profexor-sync/runs/{run.id}/commands.log</text>
    </box>
  );
}

function History({ events }: { events: AuditEvent[] }) {
  return (
    <scrollbox style={{ flexGrow: 1, flexDirection: "column" }}>
      {events.map((event) => (
        <text key={event.id} fg={statusColor(event.level === "error" ? "fail" : event.level === "warn" ? "warn" : "pass")}>
          {formatTime(event.timestamp)} · {event.action} · {event.message}
        </text>
      ))}
    </scrollbox>
  );
}
