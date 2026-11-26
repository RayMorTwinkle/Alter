"""Review literal HTTP/WS endpoints in a Git snapshot without making any requests.

Print source locations only for unusual hosts. A human must resolve those locations.
A passed secret scan and a literal-host inventory cannot certify inputs built at runtime.
"""
import argparse
import collections
import io
import ipaddress
import json
import re
import subprocess
import tarfile
from urllib.parse import urlsplit

parser = argparse.ArgumentParser()
parser.add_argument("revision")
args = parser.parse_args()
sha = subprocess.check_output(["git", "rev-parse", "--verify", args.revision + "^{commit}"], text=True).strip()
archive = subprocess.check_output(["git", "archive", "--format=tar", sha])
# Each suffix below belongs to a public upstream referenced by this project.
upstreams = {
    "github.com", "github.io", "githubcopilot.com", "apple.com", "microsoft.com", "nodejs.org",
    "feishu.cn", "larksuite.com", "algolia.com", "hnrss.org", "google.com", "bing.com",
    "baidu.com", "zhihu.com", "conventionalcommits.org", "w3.org", "npmjs.org",
}
examples = {"example", "example.org", "example.net", "example.com", "invalid", "test"}
url_pattern = re.compile(r"""\b(?:https?|wss?)://[^\s<>"'`)}]+""", re.I)


def matches(host, suffixes):
    return any(host == suffix or host.endswith("." + suffix) for suffix in suffixes)


def classify(raw):
    try:
        url = urlsplit(raw)
        host = url.hostname or ""
    except ValueError:
        return "partial-or-dynamic"
    if url.username or url.password:
        return "userinfo-review"
    if "$" in host or "{" in host or not host:
        return "partial-or-dynamic"
    if host == "localhost":
        return "loopback"
    try:
        return "loopback" if ipaddress.ip_address(host).is_loopback else "literal-ip-review"
    except ValueError:
        pass
    if matches(host, examples):
        return "reserved-example"
    if matches(host, upstreams):
        return "public-upstream"
    return "review"


groups = collections.Counter()
locations = collections.defaultdict(set)
with tarfile.open(fileobj=io.BytesIO(archive), mode="r:") as files:
    for member in files:
        if not member.isfile():
            continue
        data = files.extractfile(member).read()
        if b"\0" in data:
            continue
        for number, line in enumerate(data.decode("utf-8", errors="replace").splitlines(), 1):
            for raw in url_pattern.findall(line):
                category = classify(raw)
                groups[category] += 1
                if "review" in category:
                    locations[category].add(f"{member.name}:{number}")
print(json.dumps({"revision": sha, "literalOccurrences": dict(sorted(groups.items())),
                  "reviewLocations": {k: sorted(v) for k, v in sorted(locations.items())}},
                 indent=2))
