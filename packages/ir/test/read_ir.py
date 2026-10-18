"""An independent IR reader: Python standard library only, no maestro code.

Proves the IR is language-neutral (IR-01): from the JSON alone it recovers the fan-out,
fan-in and loop structure and a valid order for the top-level nodes.

Usage: python3 read_ir.py <ir.json>
"""

import json
import sys

GROUP_KINDS = {"parMap", "map", "find", "parFind", "fold", "loop"}


def main(path):
    with open(path, encoding="utf-8") as f:
        ir = json.load(f)
    major = ir["irVersion"].split(".")[0]
    if major != "1":
        sys.exit(f"unsupported IR major version {major}")

    nodes = {n["id"]: n for n in ir["nodes"]}
    def top(node_id):
        """The outermost group holding a node, or the node itself. Scopes do not count."""
        result, p = node_id, node_id.rpartition("/")[0]
        while p:
            if p in nodes and nodes[p]["kind"] in GROUP_KINDS:
                result = p
            p = p.rpartition("/")[0]
        return result

    def members(g):
        return ", ".join(f"{name}={node}" for name, node in g["members"].items())

    def bound(g):
        c = g["cardinality"]
        return f"exactly {c['exact']}" if "exact" in c else f"up to {c['upTo']}"

    for n in ir["nodes"]:
        if n["kind"] in ("parMap", "map"):
            print(f"fan-out: {n['kind']} {n['id']}, {bound(n)} members, each {members(n)}")
        elif n["kind"] in ("find", "parFind", "fold"):
            print(f"{n['kind']}: {n['id']}, {bound(n)} members, each {members(n)}")
        elif n["kind"] == "loop":
            test = n["test"]
            tested = f", tested at {test['at']} on {test['port']['node']}.{test['port']['port']}"
            tolerate = ", tolerating rejected" if n.get("tolerate") else ""
            print(f"loop: {n['id']}, {bound(n)} iterations, each {members(n)}{tested}{tolerate}")
    for e in ir["edges"]:
        if e["kind"] == "collect":
            to = e["to"]
            reducer = " (reducer)" if nodes[to["node"]].get("fanin") else ""
            print(f"fan-in: {e['from']['node']}.{e['from']['port']} -> {to['node']}.{to['port']}{reducer}")

    # Kahn's algorithm over top-level nodes, in declaration order where free.
    order = [n["id"] for n in ir["nodes"] if top(n["id"]) == n["id"]]
    deps = {n: set() for n in order}
    for e in ir["edges"]:
        a, b = top(e["from"]["node"]), top(e["to"]["node"])
        if a != b:
            deps[b].add(a)
    done = []
    while len(done) < len(order):
        ready = [n for n in order if n not in done and deps[n] <= set(done)]
        if not ready:
            sys.exit("cycle")
        done.append(ready[0])
    print("order: " + " -> ".join(done))


if __name__ == "__main__":
    main(sys.argv[1])
