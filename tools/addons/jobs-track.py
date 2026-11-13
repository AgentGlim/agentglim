#!/usr/bin/env python3
"""jobs-track: code-only register of agent jobs for AgentGlim. No model calls.

One JSON file per job in $JOBS_TRACK_DIR (default ~/.agentglim/tracked-jobs).
Every command is best-effort: a tracking error never fails or blocks a launch (exit 0, except `run`,
which passes the wrapped command's exit code through).

  jobs-track start  --harness H [--plan NN-slug] [--model M] [--label L] [--cwd D] [--outdir O] [--pid P]
                    [--prompt-file F] [--prompt TEXT] [--kind autonomous|one-on-one|queue] [--id ID]
                    [--session-pid P]   (the SuperAgent's process: job is stopped if it dies)
                    prints the job id
  jobs-track finish --id ID [--rc N] [--status done|failed|stopped]
  jobs-track heartbeat --id ID
  jobs-track run    --harness H [--plan NN-slug] [--model M] [--label L] [--outdir O] -- CMD ...
                    registers CMD as a job, waits, finishes it with CMD's rc
  jobs-track claude-hook          Claude Code hook (PreToolUse via jev-gate, PostToolUse, SubagentStop); JSON on stdin
  jobs-track reap [--backfill H]  liveness: finish jobs whose pid is gone or whose rc file appeared;
                    register running agent.sh / headless-take.sh processes not yet known;
                    --backfill H also imports plan outdirs that finished in the last H hours
  jobs-track fix [--since H]      re-check the last H hours (default 24): project, label, end state; archive twins
  jobs-track list                 all records as a JSON array

project: --plan NN-slug (or a "[plan: NN-slug]" tag in the prompt) wins; else the cwd (plan folder or
a repo in plans/_run/repo-plans.json), the outdir, a parent job's prompt, a plan folder named in the prompt, a repo path
named in the prompt; else "Unassigned". End state: rc 0 = done, 124 = failed (timed out), killed = stopped, else failed.

kind (decided by code): an ancestor process headless-take.sh / claudeq.sh / cloud-take.sh = queue,
driver.mjs = autonomous, a claude/codex/pi/opencode ancestor (or the Agent tool) = subagent, anything else = one-on-one.

Process table: procfs on Linux, or the root in AGENTGLIM_PROC (tests and fixtures; pointing it at a missing path
emulates macOS/Windows). macOS reads ps, Windows reads kernel32. Liveness never sends a signal to the process.
"""
import hashlib, json, os, re, subprocess, sys, time
from pathlib import PurePosixPath

HOME = os.path.expanduser("~")
DIR = os.environ.get("JOBS_TRACK_DIR") or os.path.join(os.environ.get("AGENTGLIM_DATA") or (os.path.join(os.environ["AGENTGLIM_WORK"], "data") if os.environ.get("AGENTGLIM_WORK") else os.path.join(HOME,".agentglim")), "tracked-jobs")
ARCHIVE = os.path.join(DIR, "_archive")
KEEP_FINISHED_S = 3 * 86400          # finished records move to _archive/ after 3 days (mv, never rm)
STALE_S = 12 * 3600                  # a running job with no pid and no heartbeat for 12 h is stopped
PLAN_RE = re.compile(r"(?:dev/projects|projects/dev)/plans/(\d\d-[a-z0-9][a-z0-9-]*)")
QUEUE_BINS = ("headless-take.sh", "claudeq.sh", "cloud-take.sh", "api-take.sh")
AUTO_BINS = ("driver.mjs",)
HARNESS_BINS = {"claude": "claude", "codex": "codex", "pi": "pi", "opencode": "opencode"}
# the process table: procfs on Linux, an explicit root for fixtures/tests, and None where the OS has no procfs
PROC = os.environ.get("AGENTGLIM_PROC") or ("/proc" if sys.platform.startswith("linux") else None)


def harness_of(k):
    """agent.sh kind -> harness, as agent.sh maps it."""
    k = k or ""
    if k.startswith("codex") or k == "luna":
        return "codex"
    if k.startswith(("pi", "gofree:")):
        return "pi"
    return {"zen": "opencode", "agy": "antigravity", "cloud": "claude-cloud"}.get(k.split(":")[0], "claude")


def now_ms():
    return int(time.time() * 1000)


def jid(*parts):
    return hashlib.sha1("|".join(str(p) for p in parts).encode()).hexdigest()[:12]


def path_of(i):
    return os.path.join(DIR, re.sub(r"[^A-Za-z0-9_.-]", "_", i) + ".json")


def load(i):
    try:
        with open(path_of(i)) as f:
            return json.load(f)
    except Exception:
        return None


def save(rec):
    os.makedirs(DIR, exist_ok=True)
    p = path_of(rec["id"])
    tmp = f"{p}.{os.getpid()}.tmp"
    with open(tmp, "w") as f:
        json.dump(rec, f)
    os.replace(tmp, p)


def records():
    out = []
    try:
        names = os.listdir(DIR)
    except Exception:
        return out
    for n in names:
        if n.endswith(".json"):
            try:
                with open(os.path.join(DIR, n)) as f:
                    r = json.load(f)
                if isinstance(r, dict) and r.get("id"):  # a stray JSON file (not a job) must never stop the reaper
                    out.append(r)
            except Exception:
                pass
    return out


# ---------- process helpers ----------
def windows_identity(pid, handle=None):
    """Creation FILETIME and executable from one process handle (Popen's handle at launch)."""
    import ctypes
    from ctypes import wintypes
    kernel = ctypes.WinDLL("kernel32", use_last_error=True)
    kernel.OpenProcess.argtypes = [wintypes.DWORD, wintypes.BOOL, wintypes.DWORD]
    kernel.OpenProcess.restype = wintypes.HANDLE
    kernel.GetProcessTimes.argtypes = [wintypes.HANDLE] + [ctypes.POINTER(wintypes.FILETIME)] * 4
    kernel.GetProcessTimes.restype = wintypes.BOOL
    kernel.QueryFullProcessImageNameW.argtypes = [wintypes.HANDLE, wintypes.DWORD, wintypes.LPWSTR, ctypes.POINTER(wintypes.DWORD)]
    kernel.QueryFullProcessImageNameW.restype = wintypes.BOOL
    kernel.CloseHandle.argtypes = [wintypes.HANDLE]
    kernel.GetExitCodeProcess.argtypes = [wintypes.HANDLE, ctypes.POINTER(wintypes.DWORD)]
    kernel.GetExitCodeProcess.restype = wintypes.BOOL
    owned = handle is None
    handle = kernel.OpenProcess(0x1000, False, int(pid)) if owned else handle
    if not handle:
        return None
    try:
        code = wintypes.DWORD()
        if not kernel.GetExitCodeProcess(handle, ctypes.byref(code)) or code.value != 259:
            return None
        times = [wintypes.FILETIME() for _ in range(4)]
        size = wintypes.DWORD(32768)
        exe = ctypes.create_unicode_buffer(size.value)
        if not kernel.GetProcessTimes(handle, *[ctypes.byref(t) for t in times]):
            return None
        if not kernel.QueryFullProcessImageNameW(handle, 0, exe, ctypes.byref(size)):
            return None
        return {"pid": int(pid), "start": str((times[0].dwHighDateTime << 32) | times[0].dwLowDateTime), "executable": exe.value}
    finally:
        if owned:
            kernel.CloseHandle(handle)


def launch_path(pid):
    return os.path.join(os.path.dirname(DIR), "launched-processes", str(int(pid)) + ".json")


def registered_identity(pid, query=None):
    try:
        with open(launch_path(pid)) as f:
            saved = json.load(f)
        live = (query or windows_identity)(pid)
        if (live and saved["pid"] == live["pid"] == int(pid) and saved["start"] == live["start"]
                and saved["executable"].lower() == live["executable"].lower()):
            return saved
    except Exception:
        pass
    return None


def register_child(child):
    identity = windows_identity(child.pid, child._handle)
    if identity:
        dest = launch_path(child.pid)
        os.makedirs(os.path.dirname(dest), exist_ok=True)
        tmp = dest + "." + str(os.getpid()) + ".tmp"
        with open(tmp, "w") as f:
            json.dump(identity, f)
        os.replace(tmp, dest)
    return identity


def windows_parent(pid):
    try:
        return int(subprocess.check_output(["powershell.exe", "-NoProfile", "-NonInteractive", "-Command",
            f"(Get-CimInstance Win32_Process -Filter 'ProcessId = {int(pid)}').ParentProcessId"],
            text=True, timeout=5).strip())
    except Exception:
        return 0


def session_alive(pid, start):
    if sys.platform == "win32":
        identity = registered_identity(pid)
        return bool(start and identity and identity["start"] == start)
    return alive(pid, start)


def procfs(*parts):
    """a path inside the process table, or None when this machine has no procfs root (macOS, Windows)."""
    return os.path.join(PROC, *parts) if PROC else None


def read_proc(pid, name, mode="r"):
    """one file of a process's procfs entry, or None: a dead pid, a missing root and a fixture tree never raise."""
    path = procfs(str(int(pid)), name)
    if not path:
        return None
    try:
        with open(path, mode) as f:
            return f.read()
    except Exception:
        return None


def read_cwd(pid):
    """a process's working directory from procfs, or None (no procfs root, dead pid)."""
    path = procfs(str(int(pid)), "cwd")
    if not path:
        return None
    try:
        return os.readlink(path)
    except OSError:
        return None


def proc_pids():
    """every pid in the process table; empty when this machine has no procfs, so discovery finds nothing."""
    if not PROC:
        return []
    try:
        return [int(n) for n in os.listdir(PROC) if n.isdigit()]
    except OSError:
        return []


def stat_of(pid):
    """(state, ppid, pgid, start identity) from the native process table, or None."""
    if PROC:  # procfs: Linux, or a fixture root through AGENTGLIM_PROC
        s = read_proc(pid, "stat")
        try:
            f2 = s[s.rindex(")") + 2:].split()
            return f2[0], int(f2[1]), int(f2[2]), int(f2[19])
        except (AttributeError, IndexError, TypeError, ValueError):
            return None
    if sys.platform == "win32":
        identity = windows_identity(pid)
        return ("S", windows_parent(pid), 0, identity["start"]) if identity else None
    if sys.platform == "darwin":
        try:
            # macOS has no procfs. Keep lstart as an opaque, locale-stable PID identity.
            fields = subprocess.check_output(
                ["ps", "-p", str(int(pid)), "-o", "stat=,ppid=,pgid=,lstart="],
                text=True, stderr=subprocess.DEVNULL, timeout=3,
                env={**os.environ, "LC_ALL": "C"},
            ).split(None, 3)
            if len(fields) != 4 or len(fields[3].split()) != 5:
                return None
            return fields[0][0], int(fields[1]), int(fields[2]), " ".join(fields[3].split())
        except (OSError, ValueError, subprocess.SubprocessError):
            return None
    return None


def cmdline(pid):
    """a process's argv: procfs, its image name on Windows, ps on macOS, [] when unknown."""
    if PROC:
        raw = read_proc(pid, "cmdline", "rb")
        return [x.decode(errors="replace") for x in raw.split(b"\0") if x] if raw is not None else []
    if sys.platform == "win32":
        identity = windows_identity(pid)
        return [identity["executable"]] if identity else []
    if sys.platform == "darwin":
        try:
            out = subprocess.check_output(
                ["ps", "-p", str(int(pid)), "-o", "command="],
                text=True, stderr=subprocess.DEVNULL, timeout=3,
                env={**os.environ, "LC_ALL": "C"},
            )
            return out.split()
        except (OSError, ValueError, subprocess.SubprocessError):
            return []
    return []


def ancestors(pid, depth=40):
    out, seen = [], set()
    if sys.platform == "win32":
        child_start = None
        while pid and pid > 1 and pid not in seen and len(out) < depth:
            seen.add(pid)
            identity = windows_identity(pid)
            if not identity or (child_start is not None and int(identity["start"]) > child_start):
                break
            out.append(pid)
            child_start = int(identity["start"])
            pid = windows_parent(pid)
        return out
    while pid and pid > 1 and pid not in seen and len(out) < depth:
        seen.add(pid)
        out.append(pid)
        st = stat_of(pid)
        pid = st[1] if st else 0
    return out


def proc_started_ms(starttime):
    """a procfs starttime in clock ticks -> epoch ms, or None without a procfs root."""
    if not PROC:
        return None
    try:
        with open(os.path.join(PROC, "stat")) as f:
            bt = next(int(l.split()[1]) for l in f if l.startswith("btime "))
        return int((bt + starttime / os.sysconf("SC_CLK_TCK")) * 1000)
    except Exception:
        return None


def posix_alive(pid):
    """a POSIX existence probe that signals nothing: only signal 0 is sent, and PermissionError means it exists."""
    try:
        os.kill(int(pid), 0)
        return True
    except PermissionError:
        return True
    except (OSError, ValueError):
        return False


def windows_alive(pid):
    """Query a Windows process without sending it a signal; access denial is inconclusive."""
    import ctypes
    from ctypes import wintypes
    kernel = ctypes.WinDLL("kernel32", use_last_error=True)
    kernel.OpenProcess.argtypes = [wintypes.DWORD, wintypes.BOOL, wintypes.DWORD]
    kernel.OpenProcess.restype = wintypes.HANDLE
    kernel.GetExitCodeProcess.argtypes = [wintypes.HANDLE, ctypes.POINTER(wintypes.DWORD)]
    kernel.GetExitCodeProcess.restype = wintypes.BOOL
    kernel.CloseHandle.argtypes = [wintypes.HANDLE]
    kernel.CloseHandle.restype = wintypes.BOOL
    handle = kernel.OpenProcess(0x1000, False, pid)  # PROCESS_QUERY_LIMITED_INFORMATION
    if not handle:
        return ctypes.get_last_error() != 87  # invalid PID is gone; access denied is unknown
    try:
        code = wintypes.DWORD()
        return not kernel.GetExitCodeProcess(handle, ctypes.byref(code)) or code.value == 259
    finally:
        kernel.CloseHandle(handle)


def alive(pid, start=None, platform=None, windows_query=None):
    """is the pid still alive? The process table's state and start identity where there is one, else a spawn-free
    probe: os.kill(pid, 0) on POSIX, kernel32 on Windows. Never calls os.kill on Windows, where Python turns
    kill(pid, 0) into TerminateProcess and the "liveness" check would kill the process."""
    plat = platform or sys.platform
    try:
        pid = int(pid or 0)
    except (TypeError, ValueError):
        return False
    if pid <= 0:
        return False
    st = stat_of(pid) if (plat != "win32" or PROC) else None
    if st:
        return st[0] != "Z" and (start is None or st[3] == start)
    if plat == "win32":
        if start is not None:
            identity = (windows_query or windows_identity)(pid)
            return bool(isinstance(identity, dict) and identity.get("start") == start)
        return bool((windows_query or windows_alive)(pid))
    # No live entry in the process table, or no process table at all (macOS/Windows, AGENTGLIM_PROC pointing
    # nowhere, an empty procfs inside a sandbox): a signal-free existence probe confirms the pid is really gone.
    return posix_alive(pid)


def kind_of(pid):
    for p in ancestors(pid or os.getpid()):
        a = " ".join(cmdline(p)[:3])
        if any(b in a for b in QUEUE_BINS):
            return "queue"
        if any(b in a for b in AUTO_BINS):
            return "autonomous"
    # launched from inside a harness session (the SuperAgent's agent.sh / jobs-track run): a sub-item, not chat work
    for p in ancestors(pid or os.getpid()):
        if any(os.path.basename(x) in HARNESS_BINS for x in cmdline(p)[:2]):
            return "subagent"
    return "one-on-one"


def harness_pid(name, pid=None):
    """nearest ancestor that is the harness binary (the SuperAgent session's process)."""
    for p in ancestors(pid or os.getppid()):
        if sys.platform == "win32":
            identity = registered_identity(p)
            if identity and identity["executable"].replace("\\", "/").split("/")[-1].lower() == name + ".exe":
                return p
        elif any(os.path.basename(x) == name for x in cmdline(p)[:2]):
            return p
    return None


MAP_FILE = os.environ.get("REPO_PLANS_FILE") or os.path.join(os.environ.get("AGENTGLIM_RUN", os.environ.get("AGENTGLIM_DATA", os.path.join(HOME,".agentglim"))), "repo-plans.json")
# read-only tool / library locations never count as the project
TOOL_RE = re.compile(r"/dev/projects/[A-Za-z0-9._-]+/(?:node_modules|vendor|\.venv|venv|site-packages)\b[^\s'\"]*|/\.cache/[^\s'\"]*|/node_modules/[^\s'\"]*")
PLANS_ROOT = os.path.expanduser(os.environ.get("AGENTGLIM_PLANS") or os.path.join(os.environ.get("AGENTGLIM_DATA") or os.path.join(HOME, ".agentglim"), "plans"))
PROJECTS_ROOT = os.path.expanduser(os.environ.get("AGENTGLIM_PROJECTS") or f"{HOME}/dev/projects")


# ---------- project detection ----------
# Attribution order: explicit --plan / a "[plan: NN-slug]" tag in the prompt, then the cwd (a plan folder,
# or a repo mapped in repo-plans.json), then the outdir / prompt-file location, then a parent job's prompt (an outdir nested
# in another job's folder is a sub-task of that job), then a plan folder named in the prompt, then a repo path named in the
# prompt. Nothing else: no path fragments ("video-", "projects", "out") and no bare words like "AgentGlim". Unknown jobs go
# to the "Unassigned" group.
UNASSIGNED = "Unassigned"
PLAN_NAME = r"\d\d-[a-z0-9]+(?:-[a-z0-9]+)*"
TAG_RE = re.compile(r"\[plan:\s*([^\]\s]+)\s*\]", re.I)
BAD_NAMES = {"plans", "projects", "dev", "out", "tmp", "bin", "src", "app", "build", "home", "user", "unassigned", "dist", "lib"}
# a name ends where a path or a sentence ends: never at "-" (video-*) or before a file extension (70-leads.py)
END = r"(?=/|[\s`'\"),;:\]]|[.!?](?:[\s`'\")]|$)|$)"
# the SuperAgent's own work (observatory__* queue requests: rejects, priority asks) is drawn on the SuperAgent row (2026-11-12)
SUPERAGENT = "SuperAgent"
QMODEL = {"fable": "claude-fable-5-1", "opus": "claude-opus-5-5", "sonnet": "claude-sonnet-5-5"}  # .req model= -> id, as headless-take.sh maps it


def queue_req(req):
    """a queue .req path -> (plan, stage): NN-slug__stage -> (NN-slug, stage); observatory__x -> (SuperAgent, x); else (None, name)"""
    b = (req or "").replace("\\", "/").rsplit("/", 1)[-1]
    b = b[:-4] if b.endswith(".req") else b
    m = re.fullmatch(r"(" + PLAN_NAME + r")__(.+)", b)
    if m:
        return m.group(1), m.group(2)
    if b.startswith("observatory__"):
        return SUPERAGENT, b[len("observatory__"):]
    return None, b or None


def norm(p):
    home = HOME.replace("\\", "/")
    p = (p or "").replace("\\", "/").replace(f"{home}/projects/dev/", f"{home}/dev/projects/")
    return p.replace("~/projects/dev/", "~/dev/projects/").replace("~/", f"{home}/") if p.startswith("~/") else p


def good_name(n):
    return bool(n) and bool(re.fullmatch(r"[A-Za-z0-9](?:[A-Za-z0-9._-]*[A-Za-z0-9])?", n)) and n.lower() not in BAD_NAMES


def _depth(p):
    return len(PurePosixPath(p or "").parts)


def _under(path, root):
    """the components of `path` below `root`, or None when it is not inside; compares Path.parts (case-folded with
    os.path.normcase, so Windows paths compare as Windows does), never a string prefix or a hard-coded "/"."""
    p = PurePosixPath(path or "").parts
    r = PurePosixPath(root or "").parts
    if len(p) <= len(r):
        return None
    if any(os.path.normcase(a) != os.path.normcase(b) for a, b in zip(p, r)):
        return None
    return p[len(r):]


def plan_roots():
    return sorted({norm(PLANS_ROOT).rstrip("/"), norm(f"{HOME}/dev/projects/plans")}, key=_depth, reverse=True)


def projects_root():
    return norm(PROJECTS_ROOT).rstrip("/")


def repo_plans():
    """external repo -> owning plan, from plans/_run/repo-plans.json (built by repo-plans-build.py)."""
    try:
        with open(MAP_FILE) as f:
            j = json.load(f)
        return j if isinstance(j, dict) else {}
    except Exception:
        return {}


def resolve_name(name):
    """an explicit --plan / [plan: X] value -> (project, isPlan), or None when it is not a usable name"""
    n = norm((name or "").strip()).rstrip("/")
    if "/" in n:
        n = os.path.basename(n)
    if n.lower() == SUPERAGENT.lower():
        return SUPERAGENT, False
    if re.fullmatch(PLAN_NAME, n):
        return n, True
    rp = repo_plans()
    if n in rp:
        return rp[n], True
    if good_name(n) and os.path.isdir(os.path.join(PROJECTS_ROOT, n)):  # "goals": a real project folder, not a placeholder
        return n, False
    return None


def project_of_path(p):
    """a cwd / outdir / prompt-file path -> (project, isPlan) when it lies in a plan folder or a project folder, else None"""
    if not p:
        return None
    p = norm(p)
    for r in plan_roots():
        rest = _under(p, r)
        if rest and re.fullmatch(PLAN_NAME, rest[0]):
            return rest[0], True
    rest = _under(p, projects_root())
    if rest and rest[0] != "plans":
        n = rest[0]
        rp = repo_plans().get(n)
        if rp:
            return rp, True
        if good_name(n):
            return n, False
    return None


def named_in(text):
    """the project a prompt is about: plan folders and repo paths it names, scored by mentions; a path into the folder
    (plans/NN-slug/..., ~/dev/projects/<repo>/...) counts 2, a bare plan folder name 1. First mention wins a tie."""
    # Callable replacements treat Windows backslashes literally (\\U is not a regex escape).
    t = norm(re.sub(r"(?<![\w/~.-])~/", lambda _: HOME + "/", text or ""))
    t = TOOL_RE.sub(" ", t)
    score, first = {}, {}
    roots = [r for r in plan_roots() if os.path.isdir(r)]
    for mt in re.finditer(r"(?:^|(?<=[\s`'\"(\[/]))(" + PLAN_NAME + r")" + END, t):
        n = mt.group(1)
        pathy = t[max(0, mt.start() - 6):mt.start()].endswith("plans/")
        if not pathy and roots and not any(os.path.isdir(os.path.join(r, n)) for r in roots):
            continue
        k = (n, True)
        score[k] = score.get(k, 0) + (2 if pathy else 1)
        first.setdefault(k, mt.start())
    root = re.escape(projects_root())
    for mt in re.finditer(root + r"/([A-Za-z0-9][A-Za-z0-9._-]*?)(?=([/\s`'\"),;:\]*]|[.!?](?:\s|$)|$))", t):
        name, after = mt.group(1), mt.group(2)
        if name == "plans" or not good_name(name) or after == "*":
            continue
        if after != "/" and not os.path.isdir(os.path.join(PROJECTS_ROOT, name)):
            continue
        rp = repo_plans().get(name)
        k = (rp, True) if rp else (name, False)
        score[k] = score.get(k, 0) + 2
        first.setdefault(k, mt.start())
    if not score:
        return None
    return max(score, key=lambda k: (score[k], -first[k]))


def project_of(*texts):
    """free text (paths, prompts) -> (project, isPlan): a plan folder named, else a repo path named, else Unassigned."""
    for t in texts:
        if not t:
            continue
        r = project_of_path(t.strip()) if " " not in t.strip() and os.path.isabs(t.strip()) else None
        if r:
            return r
        r = named_in(t)
        if r:
            return r
    return UNASSIGNED, False


def parent_prompt(outdir):
    """the prompt of the job whose folder holds this outdir (asks-pages/sub-67 -> asks-pages/prompt.md), up to 3 levels"""
    d = os.path.dirname((outdir or "").rstrip("/"))
    for _ in range(3):
        if not d or d in ("/", HOME) or d.rstrip("/") in plan_roots():
            return None
        for n in ("prompt.md", "prompt"):
            f = os.path.join(d, n)
            if os.path.isfile(f):
                try:
                    with open(f, errors="replace") as fh:
                        return fh.read(20000)
                except Exception:
                    return None
        d = os.path.dirname(d)
    return None


def attribute(plan=None, cwd=None, outdir=None, prompt_file=None, prompt_text=""):
    """-> (project, isPlan, how). See the order above."""
    for v, how in ((plan, "--plan"), (next(iter(TAG_RE.findall(prompt_text or "")), None), "tag")):
        r = resolve_name(v) if v else None
        if r:
            return r[0], r[1], how
    for p, how in ((cwd, "cwd"), (outdir, "outdir"), (prompt_file, "prompt file")):
        r = project_of_path(p)
        if r:
            return r[0], r[1], how
    pp = parent_prompt(outdir) if outdir else None
    if pp:
        t = next(iter(TAG_RE.findall(pp)), None)
        r = resolve_name(t) if t else None
        r = r or named_in(pp)
        if r:
            return r[0], r[1], "parent job"
    r = named_in(prompt_text)
    if r:
        return r[0], r[1], "prompt"
    return UNASSIGNED, False, "none"


# ---------- labels ----------
LABEL_WORDS = {"agentglim": "AgentGlim", "ai": "AI", "ui": "UI", "api": "API", "pu": "PU", "html": "HTML", "rc": "rc"}
GENERIC_SLUG = re.compile(r"^(?:sub|p|r|orch|job|run|out|task|w|v\d+)?[-_]?\d*$|^(?:orch|out|run|job|task)$")


def nice_label(slug, parent=None):
    """an outdir slug -> a readable label: plan70-phase1 -> "Plan 70 phase 1"; asks-pages/sub-67 -> "Asks pages: sub 67"."""
    def h(x):
        x = re.sub(r"(?<=[a-z]{2})(?=\d)|(?<=\d)(?=[a-z]{2})", " ", x)
        w = [LABEL_WORDS.get(t.lower(), t) for t in re.split(r"[-_\s]+", x) if t]
        s = " ".join(w)
        return s[:1].upper() + s[1:]
    lab = h(slug or "job")
    if parent and GENERIC_SLUG.match((slug or "").lower()) and parent not in ("headless", "_build", "_run"):
        lab = f"{h(parent)}: {lab[:1].lower() + lab[1:]}"
    return lab


# ---------- commands ----------
def start(harness, model=None, label=None, cwd=None, outdir=None, pid=None, prompt_file=None,
          prompt=None, kind=None, id=None, launcher=None, extra=None, session_pid=None, plan=None, req=None):
    cwd = os.path.abspath(cwd or os.getcwd())
    qplan, qstage = queue_req(req) if req else (None, None)
    plan = plan or qplan  # a queue take (headless-take.sh): the plan is in the .req name, NN-slug__stage (2026-11-12)
    if req and qstage and not label:
        label = nice_label(qstage)
    ptxt = prompt or ""
    prompt_file = os.path.abspath(prompt_file) if prompt_file else None
    if prompt_file:
        try:
            with open(prompt_file, errors="replace") as f:
                ptxt = (ptxt + "\n" + f.read(20000))
        except Exception:
            pass
    outdir = os.path.abspath(outdir) if outdir else None
    project, is_plan, how = attribute(plan=plan, cwd=cwd, outdir=outdir, prompt_file=prompt_file, prompt_text=ptxt)
    pid = int(pid) if pid else None
    st = stat_of(pid) if pid else None
    rid = id or (jid(norm(outdir), pid) if outdir and pid else jid(harness, label, now_ms(), os.getpid()))
    old = load(rid)
    if old and old.get("status") == "running":
        return rid
    slug = os.path.basename(outdir.rstrip("/")) if outdir else None
    lab = label or (nice_label(slug, os.path.basename(os.path.dirname(outdir.rstrip("/")))) if slug else None) \
        or (ptxt.strip().splitlines() or ["job"])[0][:80]
    rec = {"id": rid, "project": project, "isPlan": is_plan, "projectFrom": how, "kind": kind or kind_of(pid),
           "harness": harness, "model": model or None, "label": re.sub(r"\[(?:jev|plan)[^\]]*\]\s*", "", lab).strip()[:120],
           "slug": slug, "pid": pid, "pidStart": st[3] if st else None, "pgid": st[2] if st else None,
           "outdir": norm(outdir) or None, "cwd": norm(cwd), "promptFile": norm(prompt_file) or None, "launcher": launcher,
           "started": (proc_started_ms(st[3]) if st and pid != os.getpid() else None) or now_ms(), "heartbeat": now_ms(), "ended": None, "status": "running", "rc": None, "touches": 1}
    if req:
        rec["req"] = norm(os.path.abspath(req))
    if session_pid:
        sst = stat_of(int(session_pid))
        rec.update(sessionPid=int(session_pid), sessionPidStart=sst[3] if sst else None)
    if extra:
        rec.update(extra)
    save(rec)
    return rid


KILLED_RC = {"130", "137", "143", "-9", "-15", "-2"}


def end_state(rc, platform=None):
    """exit code -> (status, reason): 0 done; 124 failed (timed out); killed by a signal = stopped; any other = failed"""
    rc = None if rc in (None, "") else str(rc).strip()
    if rc in (None, "0"):
        return "done", None
    if rc == "124":
        return "failed", "timed out"
    if (platform or sys.platform) != "win32" and (rc in KILLED_RC or rc.startswith("-")):
        return "stopped", "killed"
    return "failed", f"exit code {rc}"


def finish(id, rc=None, status=None, force=False):
    rec = load(id)
    if not rec or (rec.get("status") != "running" and not force):
        return
    reason = None
    if status is None:
        status, reason = end_state(rc)
    rec.update(status=status, rc=None if rc in (None, "") else str(rc), ended=rec.get("ended") if force and rec.get("ended") else now_ms())
    if reason:
        rec["endReason"] = reason
    else:
        rec.pop("endReason", None)
    save(rec)


def heartbeat(id):
    rec = load(id)
    if rec and rec.get("status") == "running":
        rec["heartbeat"] = now_ms()
        rec["touches"] = int(rec.get("touches") or 1) + 1
        save(rec)


def rc_file(rec):
    """the job's exit code: <outdir>/rc (or headless.rc), else agent.sh's "end kind=... rc=N" line in <outdir>/meta.
    agent.sh writes both itself, outside the sandbox, so they exist even when the agent could not write last.txt."""
    o = rec.get("outdir")
    if not o or not os.path.isdir(o):
        return None
    since = (rec.get("started") or 0) - 5000
    for n in ("rc", "headless.rc"):
        f = os.path.join(o, n)
        try:
            if os.path.getmtime(f) * 1000 >= since:
                return open(f).read().strip() or "0"
        except Exception:
            pass
    try:
        with open(os.path.join(o, "meta"), errors="replace") as f:
            ends = re.findall(r"^(\d{4}-\d\d-\d\d \d\d:\d\d:\d\d) end kind=\S+ rc=(-?\d+)", f.read(), re.M)
        if ends and time.mktime(time.strptime(ends[-1][0], "%Y-%m-%d %H:%M:%S")) * 1000 >= since:
            return ends[-1][1]
    except Exception:
        pass
    return None


def same_dir(pid):
    """the process's JOBS_TRACK_DIR (default: the live register) is this register."""
    raw = read_proc(pid, "environ", "rb")
    if raw is None:  # no procfs root (macOS, Windows), a dead pid or a fixture pid: nothing to compare against
        return True
    env = dict(x.split(b"=", 1) for x in raw.split(b"\0") if b"=" in x)
    d = env.get(b"JOBS_TRACK_DIR")
    if not d:
        return not os.environ.get("JOBS_TRACK_DIR") or os.path.realpath(DIR) == os.path.realpath(os.path.join(os.environ.get("AGENTGLIM_DATA") or (os.path.join(os.environ["AGENTGLIM_WORK"], "data") if os.environ.get("AGENTGLIM_WORK") else os.path.join(HOME,".agentglim")), "tracked-jobs"))
    return os.path.realpath(d.decode(errors="replace")) == os.path.realpath(DIR)


def discover():
    """register running agent.sh / headless-take.sh processes that have no record yet (procfs only)."""
    if not PROC:  # macOS and Windows have no procfs: there is nothing to scan
        return
    recs = records()
    known = {r["id"] for r in recs}
    # a live process that already has a record (under any id) is never registered twice
    running = {(r.get("pid"), r.get("pidStart")) for r in recs if r.get("status") == "running" and r.get("pid")}
    for p in proc_pids():
        a = cmdline(p)
        i = next((k for k, x in enumerate(a) if x.endswith("/agent.sh")), -1)
        if i >= 0:
            args, plan, k = [], None, i + 1
            while k < len(a):  # agent.sh [--plan NN-slug] <kind> <cwd> <prompt> <outdir> ...
                if a[k] == "--plan" and k + 1 < len(a):
                    plan, k = a[k + 1], k + 2
                    continue
                args.append(a[k])
                k += 1
            if len(args) < 4:
                continue
            st = stat_of(p)
            if not st or cmdline(st[1]) == a:  # a subshell fork of agent.sh: its parent owns the job
                continue
            if (p, st[3]) in running:
                continue
            kind_arg, cwd, prompt, out = args[:4]
            # relative paths are relative to agent.sh's own cwd, not the reaper's (AgentGlim runs in agentglim/app;
            # resolving there made "agentglim/app/_run/headless/<job>" twins that never found their rc file)
            pcwd = read_cwd(p)
            if not pcwd:
                continue
            cwd, prompt, out = (os.path.normpath(os.path.join(pcwd, x)) for x in (cwd, prompt, out))
            rid = jid(norm(out), p)
            if rid not in known:
                start(harness_of(kind_arg), model=kind_arg, cwd=cwd, outdir=out, pid=p,
                      prompt_file=prompt, id=rid, launcher="agent.sh (discovered)", plan=plan)
            continue
        i = next((k for k, x in enumerate(a) if os.path.basename(x) in ("jobs-track", "jobs-track.py")), -1)
        if i >= 0 and a[i + 1:i + 2] == ["run"] and "--" in a[i:]:
            if not same_dir(p):  # a wrapper writing to another register (a test's temp dir): not ours
                continue
            st = stat_of(p)
            if st and ("run-" + jid(p, st[3])) not in known:
                rest = a[i + 2:]
                k = rest.index("--")
                o = {rest[x][2:]: rest[x + 1] for x in range(0, k - 1) if rest[x].startswith("--")}
                start_run(o, rest[k + 1:] or ["?"], p, read_cwd(p))
            continue
        i = next((k for k, x in enumerate(a) if x.endswith("headless-take.sh")), -1)
        if i >= 0 and len(a) > i + 1:
            # headless-take.sh's subshell forks share its cmdline; the outermost one owns the job
            st = stat_of(p)
            if st and "headless-take.sh" in " ".join(cmdline(st[1])[:3]):
                continue
            req = a[i + 1]
            if not same_dir(p):  # a headless-take run inside a test (its own JOBS_TRACK_DIR): not ours
                continue
            # relative to headless-take's cwd (the watcher runs it as _run/bin/headless-take.sh _run/audit_queue/x.req)
            pcwd = read_cwd(p)
            if not pcwd:
                continue
            req = os.path.normpath(os.path.join(pcwd, req))
            try:
                kv = dict(l.split("=", 1) for l in open(req).read().splitlines() if "=" in l)
            except Exception:
                continue
            out = os.path.dirname(kv.get("done", "")) or None
            rid = jid(norm(out), p)
            if out and rid not in known:
                start("claude", model=QMODEL.get(kv.get("model"), kv.get("model")), cwd=kv.get("prompt", "").split("/_build/")[0], outdir=out,
                      pid=p, prompt_file=kv.get("prompt"), id=rid, kind="queue", launcher="headless-take.sh (discovered)",
                      req=req)


def backfill(hours):
    root = os.path.join(HOME, "dev/projects/plans")
    cut = time.time() - hours * 3600
    known = {r.get("outdir") for r in records()}
    for plan in os.listdir(root):
        b = os.path.join(root, plan, "_build")
        if not re.match(r"\d\d-", plan) or not os.path.isdir(b):
            continue
        for d in os.listdir(b):
            o = os.path.join(b, d)
            rcf = os.path.join(o, "rc")
            try:
                if os.path.getmtime(rcf) < cut or norm(o) in known:
                    continue
                pid = int(open(os.path.join(o, "pid")).read().strip())
                rc = open(rcf).read().strip()
            except Exception:
                continue
            kind = "autonomous" if re.match(r"v\d+-", d) else "one-on-one"
            meta = ""
            try:
                meta = open(os.path.join(o, "meta")).read()
            except Exception:
                pass
            m = re.findall(r" start kind=(\S+)", meta)
            st0 = os.path.getmtime(os.path.join(o, "pid")) * 1000
            rid = jid(norm(o), pid)
            save({"id": rid, "project": plan, "isPlan": True, "kind": kind, "harness": harness_of(m[-1] if m else ""),
                  "model": m[-1] if m else None, "label": d, "pid": pid, "pidStart": None, "pgid": None, "outdir": norm(o),
                  "cwd": os.path.join(root, plan), "launcher": "agent.sh (backfilled)", "started": int(st0),
                  "heartbeat": int(st0), "ended": int(os.path.getmtime(rcf) * 1000),
                  "status": "done" if rc == "0" else "failed", "rc": rc})


def reap(backfill_h=None):
    try:
        discover()
    except Exception:
        pass
    if backfill_h:
        try:
            backfill(float(backfill_h))
        except Exception:
            pass
    t = now_ms()
    for rec in records():
        try:
            if rec.get("status") != "running":
                if t - (rec.get("ended") or t) > KEEP_FINISHED_S * 1000:
                    os.makedirs(ARCHIVE, exist_ok=True)
                    os.replace(path_of(rec["id"]), os.path.join(ARCHIVE, os.path.basename(path_of(rec["id"]))))
                continue
            rc = rc_file(rec)
            if rc is not None:
                finish(rec["id"], rc)
                continue
            pid = rec.get("pid")
            if pid:
                if not alive(pid, rec.get("pidStart")):
                    rc = rc_file(rec)
                    if rc is not None:
                        finish(rec["id"], rc)
                    elif rec.get("outdir") and (rec.get("launcher") or "").startswith("agent.sh"):
                        # agent.sh always writes rc and an "end" meta line on its way out: neither means it was killed
                        finish(rec["id"], status="stopped")
                        r2 = load(rec["id"])
                        if r2:
                            r2["endReason"] = "process ended without an exit code (killed)"
                            save(r2)
                    else:
                        finish(rec["id"], status="done")
                continue
            sp = rec.get("sessionPid")
            if sp and not session_alive(sp, rec.get("sessionPidStart")):
                finish(rec["id"], status="stopped")
            elif t - (rec.get("heartbeat") or rec.get("started") or t) > STALE_S * 1000:
                finish(rec["id"], status="stopped")
        except Exception:
            pass


def fix(hours=24):
    """re-check records started in the last `hours` with today's rules: project attribution
    (unless set explicitly), labels, and the end state from the rc file / meta line. Twins of one process (the old
    relative-outdir bug made "<agentglim>/app/_run/headless/<job>" copies) move to _archive/twins/. Prints a summary."""
    t = now_ms()
    recs = [r for r in records() if t - (r.get("started") or 0) < hours * 3600e3]
    changed, twins = [], []
    by_proc = {}
    for r in recs:
        if r.get("pid"):
            by_proc.setdefault((r["pid"], r.get("pidStart")), []).append(r)
    for group in by_proc.values():
        if len(group) < 2:
            continue
        real = [r for r in group if r.get("outdir") and os.path.isdir(r["outdir"])]
        for r in group:
            if real and r not in real:
                d = os.path.join(ARCHIVE, "twins")
                os.makedirs(d, exist_ok=True)
                os.replace(path_of(r["id"]), os.path.join(d, os.path.basename(path_of(r["id"]))))
                twins.append(r["id"])
    for r in recs:
        if r["id"] in twins or not load(r["id"]):
            continue
        before = (r.get("project"), r.get("isPlan"), r.get("status"), r.get("label"))
        o = r.get("outdir")
        if r.get("projectFrom") not in ("--plan", "tag"):
            pf = r.get("promptFile") or (os.path.join(o, "prompt.md") if o and os.path.isfile(os.path.join(o, "prompt.md")) else None)
            ptxt = ""
            if pf:
                try:
                    with open(pf, errors="replace") as fh:
                        ptxt = fh.read(20000)
                except Exception:
                    pass
            explicit = queue_req(r.get("req"))[0] if r.get("req") else None
            if not explicit and (r.get("launcher") or "").startswith("headless-take") and "/plans/_observatory/" in (o or ""):
                explicit = SUPERAGENT
            m = re.search(r" start .*?plan=(\S+)", open(os.path.join(o, "meta")).read()) if o and os.path.isfile(os.path.join(o, "meta")) else None
            if m:
                explicit = m.group(1)
            if pf or explicit or (o and os.path.isdir(o)) or not good_name(r.get("project") or "") or r.get("project") in ("plans", "~"):
                proj, isp, how = attribute(plan=explicit, cwd=r.get("cwd"), outdir=o if o and os.path.isdir(o) else None,
                                           prompt_file=pf, prompt_text=ptxt)
                # an Agent-tool or chat record without its prompt keeps a valid project it already had
                if how == "none" and good_name(r.get("project") or "") and r.get("project") not in ("plans", "~") and not pf:
                    proj, isp, how = r["project"], r.get("isPlan"), r.get("projectFrom") or "kept"
                r.update(project=proj, isPlan=isp, projectFrom=how)
        if o and r.get("label") == os.path.basename(o.rstrip("/")):
            r["slug"] = r["label"]
            r["label"] = nice_label(r["label"], os.path.basename(os.path.dirname(o.rstrip("/"))))
        save(r)
        if r.get("status") in ("stopped", "failed") and r.get("rc") in (None, ""):
            rc = rc_file(r)
            if rc is not None:
                finish(r["id"], rc, force=True)
        r2 = load(r["id"]) or r
        after = (r2.get("project"), r2.get("isPlan"), r2.get("status"), r2.get("label"))
        if after != before:
            changed.append(f"{r['id']}: {before} -> {after}")
    print(json.dumps({"checked": len(recs), "twinsArchived": twins, "changed": changed}, indent=1))


def claude_hook(ev):
    name = ev.get("hook_event_name")
    ti = ev.get("tool_input") or {}
    tu = ev.get("tool_use_id")
    if name == "PreToolUse" and ev.get("tool_name") == "Agent":
        sp = harness_pid("claude")
        identity = registered_identity(sp) if sp and sys.platform == "win32" else None
        st = stat_of(sp) if sp and sys.platform != "win32" else None
        if sys.platform == "win32" and not identity:
            sp = None
        start("claude", model=ti.get("model") or "inherit", label=ti.get("description") or None, cwd=ev.get("cwd"),
              prompt=ti.get("prompt") or "", id="cc-" + (tu or jid(now_ms())), launcher="claude Agent tool", kind="subagent",
              extra={"sessionId": ev.get("session_id"), "sessionPid": sp, "sessionPidStart": identity["start"] if identity else st[3] if st else None,
                     "subagentType": ti.get("subagent_type")})
    elif name == "PostToolUse" and ev.get("tool_name") == "Agent":
        rec = load("cc-" + str(tu))
        tr = ev.get("tool_response") or {}
        if not rec:
            return
        if isinstance(tr, dict) and tr.get("isAsync"):
            rec.update(agentId=tr.get("agentId"), model=tr.get("resolvedModel") or rec.get("model"),
                       outdir=tr.get("outputFile") or rec.get("outdir"))
            save(rec)
        else:
            if isinstance(tr, dict) and tr.get("resolvedModel"):
                rec["model"] = tr["resolvedModel"]
                save(rec)
            finish(rec["id"], status="done")
    elif name in ("PostToolUseFailure",) and ev.get("tool_name") == "Agent":
        finish("cc-" + str(tu), status="failed")
    elif name == "SubagentStop":
        aid = ev.get("agent_id")
        for rec in records():
            if rec.get("status") == "running" and aid and rec.get("agentId") == aid:
                rec["report"] = ev.get("agent_transcript_path")
                rec["summary"] = str(ev.get("last_assistant_message") or "")[:4000]
                save(rec)
                finish(rec["id"], status="done")


def run(argv):
    o, i = {}, 0
    while i < len(argv) and argv[i] != "--":
        if argv[i].startswith("--") and i + 1 < len(argv):
            o[argv[i][2:]] = argv[i + 1]
            i += 2
        else:
            i += 1
    cmd = argv[i + 1:]
    if not cmd:
        print("jobs-track run: no command", file=sys.stderr)
        return 2
    p = subprocess.Popen(cmd)
    child_identity = None
    if sys.platform == "win32":
        try:
            child_identity = register_child(p)
        except Exception:
            pass  # Missing identity means no guard eligibility or hook session attribution.
    rid = None
    try:
        rid = start_run(o, cmd, os.getpid(), os.getcwd())
        if child_identity:
            rec = load(rid)
            rec.update(childPid=p.pid, childIdentity=child_identity)
            save(rec)
    except Exception:
        pass
    try:
        rc = p.wait()
    except KeyboardInterrupt:
        p.terminate()
        rc = p.wait()
    try:
        if rid:
            finish(rid, rc, "stopped" if rc < 0 and sys.platform != "win32" else None)
    except Exception:
        pass
    return rc if rc >= 0 or sys.platform == "win32" else 128 - rc


def start_run(o, cmd, pid, cwd):
    """a `jobs-track run` wrapper's job; the id comes from the wrapper's pid, so the reaper's procfs discovery of a
    wrapper that could not write (inside a Codex sandbox) makes the same record."""
    st = stat_of(pid)
    return start(o.get("harness") or os.path.basename(cmd[0]), model=o.get("model"), label=o.get("label") or " ".join(cmd)[:80],
                 cwd=o.get("cwd") or cwd, outdir=o.get("outdir"), pid=pid, prompt=o.get("prompt"),
                 prompt_file=o.get("prompt-file"), kind=o.get("kind"), launcher="jobs-track run", plan=o.get("plan"),
                 id="run-" + jid(pid, st[3] if st else 0))


def opts(argv):
    o, i = {}, 0
    while i < len(argv):
        if argv[i].startswith("--") and i + 1 < len(argv):
            o[argv[i][2:].replace("-", "_")] = argv[i + 1]
            i += 2
        else:
            i += 1
    return o


def main(a):
    cmd = a[0] if a else ""
    if cmd == "run":
        return run(a[1:])
    try:
        o = opts(a[1:])
        if cmd == "start":
            print(start(o.pop("harness", "?"), **o))
        elif cmd == "finish":
            finish(o["id"], o.get("rc"), o.get("status"))
        elif cmd == "heartbeat":
            heartbeat(o["id"])
        elif cmd == "reap":
            reap(o.get("backfill"))
        elif cmd == "fix":
            fix(float(o.get("since") or 24))
        elif cmd == "list":
            print(json.dumps(sorted(records(), key=lambda r: r.get("started") or 0)))
        elif cmd == "claude-hook":
            claude_hook(json.load(sys.stdin))
        else:
            print(__doc__)
    except Exception as e:
        print(f"jobs-track: {e}", file=sys.stderr)
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
