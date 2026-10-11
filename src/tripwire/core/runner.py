"""Run cases x k trials (x prompt variants) and write a Run as it goes."""

from __future__ import annotations

import threading
import time
from concurrent.futures import ThreadPoolExecutor, as_completed
from dataclasses import asdict, dataclass
from pathlib import Path
from typing import Callable

from tripwire.core.agent import PROTOCOL_VERSION, PromptAgent
from tripwire.core.backends import Backend, BackendError, Refusal, Stopped, budget
from tripwire.core.env import diff
from tripwire.core.graders import Judge, grade
from tripwire.core.scenario import Scenario
from tripwire.core.trace import Run, Trial, Turn
from tripwire.core.user import PersonaUser, ScriptedUser

MAX_EXCHANGES = 10
TRIAL_TIMEOUT_S = 600  # one conversation; normal ones take 30-120 s


@dataclass
class Models:
    agent: str
    user: str
    judge: str

    @staticmethod
    def from_scenario(scn: Scenario, **override) -> "Models":
        d = {"agent": "claude-haiku-5-5", "user": "claude-haiku-5-5", "judge": "claude-sonnet-5-5"}
        d.update(scn.defaults.get("models", {}))
        d.update({k: v for k, v in override.items() if v})
        return Models(**d)


@dataclass
class Job:
    case: dict
    trial: int
    variant: str
    sections: dict[str, str]


def run_trial(scn: Scenario, job: Job, models: Models, backend: Backend, use_judge: bool,
              trial_timeout_s: float | None = TRIAL_TIMEOUT_S, trial_retries: int = 1,
              stop: threading.Event | None = None, live: "Live | None" = None) -> Trial | None:
    """One conversation, graded. Infra failures (timeout, backend error) rerun the whole
    trial up to trial_retries times; policy failures never do. Returns None if stopped."""
    retries = 0
    while True:
        trial, exc = _attempt(scn, job, models, backend, use_judge, trial_timeout_s, stop, live, retries)
        if isinstance(exc, Stopped) or (stop is not None and stop.is_set()):
            return None
        if exc is None or not isinstance(exc, BackendError) or isinstance(exc, Refusal) or retries >= trial_retries:
            trial.retries = retries
            return trial
        retries += 1


def _attempt(scn, job, models, backend, use_judge, trial_timeout_s, stop, live, attempt):
    t0 = time.time()
    clock = lambda: round(time.time() - t0, 2)  # noqa: E731
    trial = Trial(case_id=job.case["id"], trial=job.trial, variant=job.variant)
    key = f"{job.variant}/{job.case['id']}/{job.trial}"
    if live:
        live.start(key, trial, attempt)
    env = scn.env_cls(scn.fixtures)
    before = env.snapshot()
    agent = PromptAgent(job.sections, models.agent, backend)
    case = job.case
    user = (ScriptedUser(case["script"]) if "script" in case
            else PersonaUser(case["persona"], models.user, backend, max_turns=case.get("max_turns", 6)))
    judge = Judge(backend, models.judge) if use_judge else None
    def phase(p: str) -> None:
        if live:
            live.update(key, phase=p)

    def on_turn(t: Turn) -> None:  # stream agent turns into the trial so the UI sees them live
        trial.turns.append(t)
        phase("agent")

    exc: Exception | None = None
    try:
        with budget(trial_timeout_s, stop) as b:
            for _ in range(MAX_EXCHANGES):
                phase("customer")
                msg = user.next(trial.turns)
                if msg is None:
                    break
                trial.turns.append(Turn("user", text=msg, t=clock()))
                phase("agent")
                agent.respond(env, list(trial.turns), clock, on_turn=on_turn)
    except Exception as e:  # keep the partial transcript; a crashed trial counts as failed
        exc = e
        trial.error = f"{type(e).__name__}: {e}"
    trial.protocol_retries = b.protocol_retries
    if isinstance(exc, Stopped):
        if live:
            live.end(key)
        return trial, exc
    phase("grading")
    trial.state_diff = diff(before, env.state)
    try:
        with budget(None, stop) as gb:  # grading gets its own time; judge calls keep their per-call timeout
            trial.verdicts = grade(trial, env.state, case.get("checks", []), scn.rules, scn.custom_checks, judge)
        trial.protocol_retries += gb.protocol_retries
    except Exception as e:  # e.g. the judge hit a rate limit: the trial can't be scored, so it's an infra error
        exc = exc or e
        trial.error = trial.error or f"grading failed: {type(e).__name__}: {e}"
    trial.passed = trial.error is None and all(v.passed for v in trial.verdicts if not v.error)
    trial.cost_usd = round(agent.cost_usd + getattr(user, "cost_usd", 0) + getattr(env, "cost_usd", 0)
                           + (judge.cost_usd if judge else 0), 5)
    trial.latency_s = round(time.time() - t0, 2)
    if live:
        live.end(key)
    return trial, exc


class Live:
    """Trials in flight, mirrored into run.live and saved every ~1.5 s while anything changed."""

    def __init__(self, run: Run, runs_dir: Path, lock: threading.Lock, every_s: float = 1.5):
        self.run, self.runs_dir, self.lock, self.every_s = run, runs_dir, lock, every_s
        self.entries: dict[str, dict] = {}
        self.trials: dict[str, Trial] = {}
        self.dirty = False
        self._done = threading.Event()
        self._thread = threading.Thread(target=self._loop, daemon=True)

    def __enter__(self):
        self._thread.start()
        return self

    def __exit__(self, *exc):
        self._done.set()
        self._thread.join(timeout=5)
        with self.lock:
            self.entries.clear()
            self.run.live = []

    def start(self, key: str, trial: Trial, attempt: int) -> None:
        with self.lock:
            self.trials[key] = trial
            self.entries[key] = {"key": key, "case_id": trial.case_id, "variant": trial.variant,
                                 "trial": trial.trial, "attempt": attempt, "started": time.time(),
                                 "phase": "customer", "turns": []}
            self.dirty = True

    def update(self, key: str, **fields) -> None:
        with self.lock:
            if key in self.entries:
                self.entries[key].update(fields)
                self.dirty = True

    def end(self, key: str) -> None:
        with self.lock:
            self.entries.pop(key, None)
            self.trials.pop(key, None)
            self.dirty = True

    def snapshot(self) -> list[dict]:
        """Call with the lock held."""
        out = []
        for key, e in self.entries.items():
            t = self.trials.get(key)
            out.append({**e, "turns": [asdict(x) for x in t.turns] if t else []})
        return sorted(out, key=lambda e: e["started"])

    def _loop(self) -> None:
        while not self._done.wait(self.every_s):
            with self.lock:
                if not self.dirty:
                    continue
                self.run.live = self.snapshot()
                self.run.save(self.runs_dir)
                self.dirty = False


STOPS: dict[str, threading.Event] = {}  # run id -> stop flag, for runs in this process


def stop_run(run_id: str) -> bool:
    ev = STOPS.get(run_id)
    if ev is None:
        return False
    ev.set()
    return True


def run_jobs(scn: Scenario, run: Run, jobs: list[Job], models: Models, backend: Backend, runs_dir: Path,
             workers: int = 4, use_judge: bool = True,
             summarize: Callable[[Run], dict] | None = None,
             on_progress: Callable[[Run], None] | None = None,
             trial_timeout_s: float | None = TRIAL_TIMEOUT_S, trial_retries: int = 1,
             stop: threading.Event | None = None) -> Run:
    lock = threading.Lock()
    stop = stop or threading.Event()
    STOPS[run.id] = stop
    run.config.setdefault("total_trials", len(jobs))
    run.config.update({"trial_timeout_s": trial_timeout_s, "trial_retries": trial_retries, "workers": workers,
                       "protocol": PROTOCOL_VERSION})
    run.save(runs_dir)
    pool = ThreadPoolExecutor(max_workers=workers)
    try:
        with Live(run, runs_dir, lock) as live:
            futures = [pool.submit(run_trial, scn, j, models, backend, use_judge, trial_timeout_s,
                                   trial_retries, stop, live) for j in jobs]
            try:
                for f in as_completed(futures):
                    trial = f.result()
                    if trial is None:
                        continue
                    with lock:
                        run.trials.append(trial)
                        run.trials.sort(key=lambda t: (t.variant, t.case_id, t.trial))
                        if summarize:
                            run.summary = summarize(run)
                        run.live = live.snapshot()
                        run.save(runs_dir)
                        live.dirty = False
                    if on_progress:
                        on_progress(run)
                    if stop.is_set():
                        break
            except KeyboardInterrupt:
                stop.set()
            if stop.is_set():
                for f in futures:
                    f.cancel()
            pool.shutdown(wait=True)  # in-flight trials notice the stop within ~1 s
    finally:
        pool.shutdown(wait=False, cancel_futures=True)
        STOPS.pop(run.id, None)
    run.status = "stopped" if stop.is_set() else "done"
    if summarize:
        run.summary = summarize(run)
    run.live = []
    run.save(runs_dir)
    return run
