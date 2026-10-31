#!/usr/bin/env python3
"""Call the Forgejo API for what `fj` cannot do.

Host and repository come from the `origin` remote; `FJ_USE_BOT=1` picks the bot's key store, as `fj` does.

    forge.py api METHOD PATH [JSON]     # PATH under /repos/<owner>/<repo>; JSON from stdin when "-"
"""

from __future__ import annotations

import json
import os
import re
import subprocess
import sys
import urllib.error
import urllib.request
from http.client import HTTPResponse
from pathlib import Path
from typing import cast

# `https://host/owner/repo.git`, `ssh://git@host:port/owner/repo`, `git@host:owner/repo`.
REMOTE = re.compile(r"^(?:[a-z+]+://)?(?:[^@/]+@)?([^:/]+)(?::\d+)?[:/](.+?)/([^/]+?)(?:\.git)?/?$")
# Cloudflare in front of the forge refuses urllib's default user agent (error 1010).
USER_AGENT = "maestro-forge.py"
ERROR_PREVIEW = 300


def origin() -> tuple[str, str, str]:
    """Read the forge out of the `origin` remote.

    :returns: `(host, owner, repo)`.
    """
    url = subprocess.run(
        ["git", "remote", "get-url", "origin"], capture_output=True, text=True, check=True
    ).stdout.strip()
    match = REMOTE.match(url)
    if match is None:
        sys.exit(f"cannot read host/owner/repo out of {url!r}")
    return match.group(1), match.group(2), match.group(3)


def token(host: str) -> str:
    """Read the token `fj` itself would use.

    :param host: the forge host.
    :returns: the API token.
    """
    share = Path.home() / ".local/share"
    root = share / "fj-bot" if os.environ.get("FJ_USE_BOT") == "1" else share
    store = root / "forgejo-cli/keys.json"
    if not store.is_file():
        sys.exit(f"no key store at {store}\nrun `fj auth login`, or unset FJ_USE_BOT")
    try:
        return cast(str, json.loads(store.read_text())["hosts"][host]["token"])
    except KeyError:
        sys.exit(f"no token for {host} in {store}\nrun `fj auth login`")


def call(method: str, path: str, payload: object | None = None) -> object:
    """Send one request to the repository's API.

    :param method: the HTTP method.
    :param path: the path under `/repos/<owner>/<repo>`.
    :param payload: the JSON body, if any.
    :returns: the decoded JSON body, or `None` when there is none.
    """
    host, owner, repo = origin()
    request = urllib.request.Request(
        f"https://{host}/api/v1/repos/{owner}/{repo}{path}",
        data=json.dumps(payload).encode() if payload is not None else None,
        method=method,
        headers={
            "Authorization": "token " + token(host),
            "User-Agent": USER_AGENT,
            "Accept": "application/json",
            "Content-Type": "application/json",
        },
    )
    try:
        with cast(HTTPResponse, urllib.request.urlopen(request)) as response:
            body = response.read().decode()
    except urllib.error.HTTPError as error:
        sys.exit(f"{error.code} from {method} {path}: {error.read().decode()[:ERROR_PREVIEW]}")
    except urllib.error.URLError as error:
        sys.exit(f"cannot reach {request.full_url}: {error.reason}\ncheck the network, then retry")
    return cast(object, json.loads(body)) if body.strip() else None


def main(argv: list[str]) -> int:
    match argv:
        case ["api", method, path]:
            result = call(method.upper(), path)
        case ["api", method, path, "-"]:
            result = call(method.upper(), path, json.load(sys.stdin))
        case ["api", method, path, body]:
            result = call(method.upper(), path, json.loads(body))
        case _:
            sys.exit(__doc__)
    if result is not None:
        print(json.dumps(result, indent=2))
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
