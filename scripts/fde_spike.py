import json, re, urllib.request, concurrent.futures as cf
SLUGS = """anthropic openai sierra decagon harvey cohere scaleai elevenlabs palantir ramp databricks cognition glean writer baseten modal hebbia rippling snowflake mistral perplexity anysphere cursor replit vercel notion figma retool airtable hightouch clay unify langchain llamaindex pinecone weaviate together fireworksai crusoe lambda runwayml pika character tavus synthesia deepgram assemblyai vapi bland retellai hume abridge ambience tennr basis rogo samaya bretton norm luminance eudia spellbook legora writerai typeface jasper adept imbue reka sakana xai poolside magic augment factory codeium windsurf sourcegraph tabnine supabase neon planetscale clickhouse temporal render railway fly brex mercury plaid stripe chime gusto deel scale anduril shieldai saronic hadrian applied-intuition appliedintuition rilla zip ironclad pilot puzzle rillet campfire numeric materialize hex sigma dbtlabs fivetran census airbyte motherduck arize braintrust patronus galileo humanloop vellum openrouter""".split()
PAT = re.compile(r"forward[- ]deployed|\bFDE\b|deployed engineer|deployment strategist", re.I)
def get(u):
    try:
        with urllib.request.urlopen(urllib.request.Request(u, headers={"User-Agent":"Mozilla/5.0"}), timeout=15) as r: return json.load(r)
    except Exception: return None
def check(slug):
    out=[]
    d=get(f"https://boards-api.greenhouse.io/v1/boards/{slug}/jobs")
    if d: out+= [("greenhouse",slug,j["title"],j.get("location",{}).get("name",""),j["absolute_url"]) for j in d.get("jobs",[])]
    d=get(f"https://api.ashbyhq.com/posting-api/job-board/{slug}")
    if d: out+= [("ashby",slug,j["title"],j.get("location",""),j.get("jobUrl","")) for j in d.get("jobs",[])]
    d=get(f"https://api.lever.co/v0/postings/{slug}?mode=json")
    if isinstance(d,list): out+= [("lever",slug,j["text"],j.get("categories",{}).get("location",""),j["hostedUrl"]) for j in d]
    return slug, out
boards=0; hits=[]
with cf.ThreadPoolExecutor(24) as ex:
    for slug,out in ex.map(check,SLUGS):
        if out: boards+=1
        hits+=[h for h in out if PAT.search(h[2])]
seen=set(); rows=[]
for h in hits:
    if h[4] in seen: continue
    seen.add(h[4]); rows.append(h)
print(f"boards found: {boards}/{len(SLUGS)}  FDE-type openings: {len(rows)}")
import os; os.makedirs("data", exist_ok=True)
json.dump(rows, open("data/fde_hits.json","w"), indent=1)
from collections import Counter
for c,n in Counter(r[1] for r in rows).most_common(): print(f"{n:3d}  {c}")
