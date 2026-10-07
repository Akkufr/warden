import sys

def check_js(filename):
    with open(filename, "r", encoding="utf-8") as f:
        src = f.read()

    i = 0
    n = len(src)
    stack = []
    line = 1
    col = 1
    while i < n:
        ch = src[i]
        if ch == "\n":
            line += 1
            col = 1
            i += 1
            continue

        # Skip line comment
        if ch == "/" and i + 1 < n and src[i+1] == "/":
            while i < n and src[i] != "\n":
                i += 1
            continue

        # Skip block comment
        if ch == "/" and i + 1 < n and src[i+1] == "*":
            i += 2
            while i + 1 < n and not (src[i] == "*" and src[i+1] == "/"):
                if src[i] == "\n":
                    line += 1
                i += 1
            i += 2
            continue

        # Skip strings: single quote, double quote, backtick
        if ch in ("'", '"', '`'):
            quote = ch
            i += 1
            while i < n:
                if src[i] == "\\":
                    i += 2
                    continue
                if src[i] == quote:
                    i += 1
                    break
                if src[i] == "\n":
                    line += 1
                i += 1
            continue

        # Check brackets
        if ch in "({[":
            stack.append((ch, line, col))
        elif ch in ")}]":
            matching = {")": "(", "}": "{", "]": "["}
            if not stack:
                print(f"ERROR in {filename} at line {line}, col {col}: Unmatched {ch}")
                return False
            top, l, c = stack.pop()
            if top != matching[ch]:
                print(f"ERROR in {filename} at line {line}, col {col}: Mismatched {ch}, expected match for {top} from line {l}, col {c}")
                return False
        col += 1
        i += 1

    if stack:
        for top, l, c in stack:
            print(f"ERROR in {filename}: Unclosed {top} from line {l}, col {c}")
        return False

    print(f"SUCCESS: {filename} has 100% matched brackets, parens, and braces!")
    return True

ok1 = check_js("extension/content.js")
ok2 = check_js("extension/background.js")
if not (ok1 and ok2):
    sys.exit(1)
print("ALL EXTENSION JAVASCRIPT FILES ARE SYNTACTICALLY VALID!")
