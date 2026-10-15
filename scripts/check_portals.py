# /// script
# requires-python = ">=3.11"
# dependencies = ["pyyaml"]
# ///
"""Exit 0 when config/portals.fde.yml parses and tracks the expected FDE companies."""
import sys
import yaml

data = yaml.safe_load(open("config/portals.fde.yml"))
companies = data.get("tracked_companies") or []
bad = [c.get("name") for c in companies if not c.get("careers_url")]
print(f"{len(companies)} tracked companies, {len(bad)} missing careers_url")
sys.exit(0 if len(companies) >= 37 and not bad else 1)
