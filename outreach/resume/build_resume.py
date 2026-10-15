"""Build tailored resumes in the fixed house layout from private data files.

Code lives here (tracked). The words live in gitignored data:
  outreach/state/resume/pool.json   contact header, education variants, every vetted bullet, skills presets
  outreach/state/specs/<key>.json   one resume: which bullets, which education line, which skills preset

Usage:
  build_resume.py [<key> ...]      write <out>/<html_prefix><key>.html for each spec (default: all); prints the paths
  build_resume.py --list-bullets   {"bullets": {"<id>": "<text>"}, "specs": ["<key>", ...]}
  build_resume.py --make-spec      read {key, company, role, url, base, bullets:[ids]} on stdin, write the spec, print its path
  build_resume.py --spec-hash KEY  sha256 of the spec's canonical JSON (sorted keys)
  build_resume.py --dump KEY       the resume as JSON: sections, entries, bullets as {id, text}
  build_resume.py --pdf-path KEY   where build-all.sh must write this spec's PDF

A bullet ID is <owner>.<name>, where the owner is a job or a project in the pool (acme.llm, globex.fde_rest).
A spec that names a bullet the pool does not have fails the build (off-pool bullet). Section order is
Education, Experience, Projects, Technical Skills, always. build-all.sh renders, lints and gates.

Directories can be overridden (the tests do): RESUME_POOL, RESUME_SPECS_DIR, RESUME_OUT_DIR.
"""
import hashlib
import html
import json
import os
import re
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
POOL = Path(os.environ.get("RESUME_POOL") or ROOT / "outreach/state/resume/pool.json")
SPECS_DIR = Path(os.environ.get("RESUME_SPECS_DIR") or ROOT / "outreach/state/specs")
OUT = Path(os.environ.get("RESUME_OUT_DIR") or ROOT / "career-ops/output")

ORDER = ["education", "experience", "projects", "skills"]
KEY_RE = re.compile(r"[A-Za-z0-9][A-Za-z0-9_-]{0,63}")

CSS = """
  @page { size: Letter; margin: 0.5in; }
  * { box-sizing: border-box; }
  body { margin: 0; font-family: Helvetica, Arial, sans-serif; font-size: 10pt; line-height: 12pt; color: #000; }
  a { color: #000; text-decoration: none; }
  h1 { margin: 0; text-align: center; font-size: 20pt; font-weight: 700; line-height: 1.15; }
  .contact { margin: 2pt 0 0; text-align: center; }
  h2 { margin: 7pt 0 3pt; padding-bottom: 1pt; border-bottom: 0.5pt solid #000; font-size: 12pt; font-weight: 700; text-transform: uppercase; break-after: avoid; }
  p { margin: 0; }
  .entry { margin-top: 4pt; break-inside: avoid; }
  h2 + .entry { margin-top: 0; }
  .row { display: flex; justify-content: space-between; align-items: baseline; gap: 10pt; }
  .row > span:first-child { min-width: 0; }
  .row > span:last-child { white-space: nowrap; text-align: right; font-weight: 700; }
  .row.sub > span:last-child { font-weight: 400; }
  .sub { font-style: italic; }
  .tech { font-weight: 400; }
  ul { margin: 1pt 0 0; padding: 0; list-style: none; }
  li { margin: 0 0 1pt; padding-left: 0.17in; text-indent: -0.17in; }
  li .b { display: inline-block; width: 0.17in; text-indent: 0; }
  .skill { display: flex; }
  .skill b { flex: 0 0 1.0in; }
"""


class SpecError(Exception):
    """A spec, a request or the pool is wrong; the message says what and where."""


# ---- data -------------------------------------------------------------------------------------

def _no_duplicate_keys(pairs):
    seen = {}
    for k, v in pairs:
        if k in seen:
            raise SpecError(f"duplicate key {k!r} in JSON")
        seen[k] = v
    return seen


def read_json(path):
    try:
        return json.loads(Path(path).read_text(), object_pairs_hook=_no_duplicate_keys)
    except FileNotFoundError:
        raise SpecError(f"missing file: {path}")
    except json.JSONDecodeError as err:
        raise SpecError(f"not valid JSON: {path}: {err}")


class Pool:
    def __init__(self, data):
        self.data = data
        self.jobs = {j["id"]: j for j in data["jobs"]}
        self.projects = {p["id"]: p for p in data["projects"]}
        self.bullets = {}  # id -> text, in pool order
        owners = [j["id"] for j in data["jobs"]] + [p["id"] for p in data["projects"]]
        if len(set(owners)) != len(owners):
            raise SpecError("pool: a job or project id is used twice")
        for owner in data["jobs"] + data["projects"]:
            for name, text in owner["bullets"].items():
                self.bullets[f"{owner['id']}.{name}"] = text

    def text(self, bullet_id, owner, key):
        if bullet_id not in self.bullets:
            raise SpecError(f"off-pool bullet: {bullet_id!r} is not in the pool (spec {key})")
        if bullet_id.split(".", 1)[0] != owner:
            raise SpecError(f"off-pool bullet: {bullet_id!r} does not belong to {owner!r} (spec {key})")
        return self.bullets[bullet_id]


def load_pool():
    return Pool(read_json(POOL))


def spec_keys():
    return sorted(p.stem for p in SPECS_DIR.glob("*.json")) if SPECS_DIR.is_dir() else []


def check_key(key):
    if not isinstance(key, str) or not KEY_RE.fullmatch(key):
        raise SpecError(f"bad spec key {key!r}: letters, digits, '-' and '_' only")
    return key


def load_spec(key):
    spec = read_json(SPECS_DIR / f"{check_key(key)}.json")
    if spec.get("key") != key:
        raise SpecError(f"spec {key}: its \"key\" field says {spec.get('key')!r}")
    return spec


def spec_hash(spec):
    canonical = json.dumps(spec, sort_keys=True, separators=(",", ":"), ensure_ascii=False)
    return hashlib.sha256(canonical.encode("utf-8")).hexdigest()


def resolve(spec, pool):
    """Check a spec against the pool and return everything the renderer needs. Raises SpecError."""
    key = spec["key"]
    if spec.get("order") != ORDER:
        raise SpecError(f"spec {key}: section order must be {ORDER}")
    if not re.fullmatch(r"[A-Za-z0-9_]+", str(spec.get("pdf_name", ""))):
        raise SpecError(f"spec {key}: pdf_name must be letters, digits and underscores")
    edu = pool.data["education"]
    if spec.get("education") not in edu["variants"]:
        raise SpecError(f"spec {key}: unknown education variant {spec.get('education')!r}")
    if spec.get("skills") not in pool.data["skills_presets"]:
        raise SpecError(f"spec {key}: unknown skills preset {spec.get('skills')!r}")
    if [x.get("job") for x in spec.get("experience", [])] != list(pool.jobs):
        raise SpecError(f"spec {key}: experience must list every job once, in order: {list(pool.jobs)}")
    used = set()

    def texts(ids, owner):
        if not ids:
            raise SpecError(f"spec {key}: {owner!r} has no bullets")
        out = []
        for i in ids:
            if i in used:
                raise SpecError(f"spec {key}: bullet {i!r} is used twice")
            used.add(i)
            out.append({"id": i, "text": pool.text(i, owner, key)})
        return out

    jobs = [(pool.jobs[x["job"]], texts(x.get("bullets"), x["job"])) for x in spec["experience"]]
    projects = []
    for x in spec.get("projects", []):
        if x.get("project") not in pool.projects:
            raise SpecError(f"spec {key}: unknown project {x.get('project')!r}")
        projects.append((pool.projects[x["project"]], texts(x.get("bullets"), x["project"])))
    if len({p["id"] for p, _ in projects}) != len(projects):
        raise SpecError(f"spec {key}: a project is listed twice")
    return {
        "edu": edu, "edu_id": f"education.{spec['education']}", "edu_text": edu["variants"][spec["education"]],
        "jobs": jobs, "projects": projects, "skills": pool.data["skills_presets"][spec["skills"]],
    }


# ---- HTML (the house layout; do not change without rebuilding and comparing every resume) ---------

def e(s):
    return html.escape(s, quote=False)


def bullets(items):
    return ["  <ul>"] + [f'    <li><span class="b">•</span>{e(b)}</li>' for b in items] + ["  </ul>"]


def entry(left_html, right, sub, items, sub_right=""):
    out = ['<div class="entry">', f'  <div class="row"><span>{left_html}</span><span>{e(right)}</span></div>']
    if sub:
        out.append(f'  <div class="row sub"><span>{e(sub)}</span><span>{e(sub_right)}</span></div>')
    return "\n".join(out + bullets(items) + ["</div>"])


def job(company, dates, title, items):
    return entry(f"<b>{e(company)}</b> | <b><i>{e(title)}</i></b>", dates, None, items)


def project(p, items):
    left = f"<b>{e(p['title'])}</b>"
    if p.get("link"):
        left += f' <span class="tech">| <a href="{html.escape(p["href"])}">{e(p["link"])}</a></span>'
    left += f' <span class="tech">| {e(p["tech"])}</span>'
    return entry(left, p["date"], None, items)


def render(r, pool):
    def only_text(bs):
        return [b["text"] for b in bs]

    edu = r["edu"]
    sections = {
        "education": ["<h2>Education</h2>", job(edu["school"], edu["date"], edu["degree"], [r["edu_text"]])],
        "experience": ["", "<h2>Experience</h2>"] + [job(j["company"], j["dates"], j["title"], only_text(bs)) for j, bs in r["jobs"]],
        "projects": ["", "<h2>Projects</h2>"] + [project(p, only_text(bs)) for p, bs in r["projects"]],
        "skills": ["", "<h2>Technical Skills</h2>"] + [f'<div class="skill"><b>{e(k)}</b><span>{e(v)}</span></div>' for k, v in r["skills"]],
    }
    parts = [pool.data["header_html"]]
    for sec in ORDER:
        parts += sections[sec]
    body = "\n".join(parts)
    return (f'<!DOCTYPE html>\n<html lang="en">\n<head>\n<meta charset="utf-8">\n<title>{e(pool.data["doc_title"])}</title>\n'
            f'<style>{CSS}</style>\n</head>\n<body>\n{body}\n</body>\n</html>\n')


def html_path(key, pool):
    return OUT / f"{pool.data['html_prefix']}{key}.html"


def pdf_path(spec, pool):
    return OUT / f"{pool.data['pdf_prefix']}{spec['pdf_name']}.pdf"


def build(key, pool):
    spec = load_spec(key)
    doc = render(resolve(spec, pool), pool)
    path = html_path(key, pool)
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(doc)
    return path


# ---- commands ---------------------------------------------------------------------------------

def dump(key, pool):
    spec = load_spec(key)
    r = resolve(spec, pool)
    edu = r["edu"]
    sections = [
        {"heading": "Education", "entries": [{"title": edu["school"], "sub": edu["degree"], "dates": edu["date"],
                                              "bullets": [{"id": r["edu_id"], "text": r["edu_text"]}]}]},
        {"heading": "Experience", "entries": [{"title": j["company"], "sub": j["title"], "dates": j["dates"], "bullets": bs} for j, bs in r["jobs"]]},
        {"heading": "Projects", "entries": [{"title": p["title"], "sub": p["tech"], "dates": p["date"], "link": p.get("href"), "bullets": bs} for p, bs in r["projects"]]},
        {"heading": "Technical Skills", "entries": [{"title": k, "sub": v, "dates": "", "bullets": []} for k, v in r["skills"]]},
    ]
    return {"key": key, "company": spec.get("company", ""), "role": spec.get("role", ""), "url": spec.get("url", ""),
            "pdf_name": spec["pdf_name"], "spec_hash": spec_hash(spec), "sections": sections}


def make_spec(req, pool):
    if not isinstance(req, dict):
        raise SpecError("--make-spec wants one JSON object on stdin")
    extra = set(req) - {"key", "company", "role", "url", "base", "bullets", "pdf_name"}
    if extra:
        raise SpecError(f"--make-spec: unknown field(s) {sorted(extra)}")
    key = check_key(req.get("key"))
    for f in ("company", "role", "url"):
        if not isinstance(req.get(f, ""), str):
            raise SpecError(f"--make-spec: {f} must be text")
    ids = req.get("bullets")
    if not isinstance(ids, list) or not all(isinstance(i, str) for i in ids):
        raise SpecError("--make-spec: bullets must be a list of bullet IDs")
    if not isinstance(req.get("base"), str) or req["base"] not in spec_keys():
        raise SpecError(f"--make-spec: unknown base spec {req.get('base')!r}")
    base = load_spec(req["base"])

    target = SPECS_DIR / f"{key}.json"
    others = {k: read_json(SPECS_DIR / f"{k}.json") for k in spec_keys()}
    # Match on lower case too: macOS file names are case-insensitive, so "FDE" would land on fde.json.
    for k, s in others.items():
        if k.lower() == key.lower() and (s.get("hand_made") or k != key):
            raise SpecError(f"--make-spec: key {key!r} collides with the existing spec {k!r}")
    # The PDF's file name is what a recruiter sees, so the caller may give a clean
    # one; without it the name falls back to the key.
    pdf_name = req.get("pdf_name") or re.sub(r"[^A-Za-z0-9]+", "_", key).strip("_")
    if not isinstance(pdf_name, str) or not re.fullmatch(r"[A-Za-z0-9]+(?:_[A-Za-z0-9]+)*", pdf_name) or len(pdf_name) > 60:
        raise SpecError("--make-spec: pdf_name must be words of letters and digits joined by single underscores, 60 characters at most")
    for k, s in others.items():
        if k != key and str(s.get("pdf_name", "")).lower() == pdf_name.lower():
            raise SpecError(f"--make-spec: key {key!r} would write the same PDF as spec {k!r} ({s['pdf_name']})")
    new_pdf = OUT / f"{pool.data['pdf_prefix']}{pdf_name}.pdf"
    if new_pdf.exists() and not target.exists():
        raise SpecError(f"--make-spec: {new_pdf.name} already exists and no spec owns it; pick another key")

    by_owner = {}  # owner -> ids, owners in order of first appearance
    for i in ids:
        if i not in pool.bullets:
            raise SpecError(f"--make-spec: unknown bullet ID {i!r}")
        by_owner.setdefault(i.split(".", 1)[0], []).append(i)
    if len(set(ids)) != len(ids):
        raise SpecError("--make-spec: a bullet ID is given twice")
    empty = [j for j in pool.jobs if j not in by_owner]
    if empty:
        raise SpecError(f"--make-spec: every job must keep at least one bullet; none given for {empty}")

    spec = {
        "key": key, "company": req.get("company", ""), "role": req.get("role", ""), "url": req.get("url", ""),
        "pdf_name": pdf_name, "hand_made": False, "base": base["key"],
        "order": base.get("order"), "education": base.get("education"), "skills": base.get("skills"),
        "experience": [{"job": x["job"], "bullets": by_owner[x["job"]]} for x in base["experience"]],
        "projects": [{"project": o, "bullets": b} for o, b in by_owner.items() if o in pool.projects],
    }
    resolve(spec, pool)  # never write a spec the build would refuse
    SPECS_DIR.mkdir(parents=True, exist_ok=True)
    tmp = target.with_suffix(".json.tmp")
    tmp.write_text(json.dumps(spec, indent=2, ensure_ascii=False) + "\n")
    tmp.replace(target)
    return target


def main(argv):
    pool = load_pool()
    cmd = argv[0] if argv and argv[0].startswith("--") else None
    if cmd == "--list-bullets":
        print(json.dumps({"bullets": pool.bullets, "specs": spec_keys()}, indent=2, ensure_ascii=False))
    elif cmd == "--make-spec":
        try:
            req = json.load(sys.stdin, object_pairs_hook=_no_duplicate_keys)
        except json.JSONDecodeError as err:
            raise SpecError(f"--make-spec: stdin is not valid JSON: {err}")
        print(make_spec(req, pool))
    elif cmd in ("--spec-hash", "--dump", "--pdf-path"):
        if len(argv) != 2:
            raise SpecError(f"{cmd} wants exactly one spec key")
        if cmd == "--spec-hash":
            print(spec_hash(load_spec(argv[1])))
        elif cmd == "--dump":
            print(json.dumps(dump(argv[1], pool), indent=2, ensure_ascii=False))
        else:
            spec = load_spec(argv[1])
            resolve(spec, pool)
            print(pdf_path(spec, pool))
    elif cmd:
        raise SpecError(f"unknown option {cmd}; see the top of {Path(__file__).name}")
    else:
        keys = argv or spec_keys()
        if not keys:
            raise SpecError(f"no specs in {SPECS_DIR}")
        for k in keys:
            print(build(k, pool))


if __name__ == "__main__":
    try:
        main(sys.argv[1:])
    except SpecError as err:
        print(f"build_resume: {err}", file=sys.stderr)
        sys.exit(1)
    except (KeyError, TypeError) as err:
        print(f"build_resume: malformed spec or pool: {err!r}", file=sys.stderr)
        sys.exit(1)
