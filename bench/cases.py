"""Benchmark cases. Each case is one conversation of one or more turns.

tier is the smallest model expected to answer reliably; the report compares the pick against it.
good is a known-correct answer, so `bench.py selftest` can prove each check accepts it.
"""
import random
import re
import subprocess
import sys
import tempfile
import textwrap
from dataclasses import dataclass, field
from typing import Callable

CODE_RULE = "\n\nReply with only the code in one ```python block, no tools, no explanation."


@dataclass
class Turn:
    prompt: str
    check: Callable[[str], bool]
    good: str
    tier: str | None = None  # None: no routing expectation (follow-ups)


@dataclass
class Case:
    name: str
    turns: list[Turn]
    tags: list[str] = field(default_factory=list)
    # Expected cache-guard outcome on the turn at this index: True = kept the previous model.
    kept_at: dict[int, bool] = field(default_factory=dict)


def last_python_block(text):
    blocks = re.findall(r"```(?:python|py)?\s*\n(.*?)```", text, re.S)
    return blocks[-1] if blocks else text


def run_tests(tests):
    def check(answer):
        src = last_python_block(answer) + "\n\n" + textwrap.dedent(tests) + "\nprint('ALL_OK')\n"
        with tempfile.NamedTemporaryFile("w", suffix=".py", delete=False, encoding="utf-8") as f:
            f.write(src)
        try:
            out = subprocess.run([sys.executable, "-I", f.name], capture_output=True, text=True, timeout=30)
            return "ALL_OK" in out.stdout
        except subprocess.TimeoutExpired:
            return False

    return check


def has(*patterns):
    return lambda a: all(re.search(p, a, re.I) for p in patterns)


def number(n):
    return has(rf"(?<![\d.]){n}(?![\d.])")


def single(name, tier, prompt, check, good, tags=()):
    return Case(name, [Turn(prompt, check, good, tier)], [tier, *tags])


# --- haystack for the big-context scenario: ~25k tokens of correct helpers and one planted bug ---

def haystack(seed=7, count=1000):
    rnd = random.Random(seed)
    ops = [
        ("returns the sum of the first {k} items", "return sum(xs[:{k}])"),
        ("returns the largest of the last {k} items", "return max(xs[-{k}:])"),
        ("counts items greater than {k}", "return sum(1 for x in xs if x > {k})"),
        ("returns every item multiplied by {k}", "return [x * {k} for x in xs]"),
        ("returns items at indices divisible by {k}", "return [x for i, x in enumerate(xs) if i % {k} == 0]"),
    ]
    bug_at = rnd.randrange(count)
    fns = []
    for n in range(count):
        k = rnd.randint(2, 9)
        if n == bug_at:
            doc, body = f"returns the sum of the first {k} items", f"return sum(xs[i] for i in range({k} + 1))"
        else:
            doc, body = rnd.choice(ops)
        fns.append(f'def helper_{n:03}(xs):\n    """{doc.format(k=k)}."""\n    {body.format(k=k)}\n')
    return "\n".join(fns), f"helper_{bug_at:03}"


HAYSTACK, BUGGY = haystack()

CASES = [
    # --- trivial ---
    single("camel", "haiku", "Convert the identifier hello_world_example to camelCase. Reply with only the result.",
           has(r"\bhelloWorldExample\b"), "helloWorldExample"),
    single("http418", "haiku", "What does HTTP status 418 mean? A few words.", has(r"teapot"), "I'm a teapot"),
    single("slice", "haiku", "In Python, what does [1, 2, 3][::-1] evaluate to? Only the value.",
           has(r"\[3,\s*2,\s*1\]"), "[3, 2, 1]"),
    single("gitundo", "haiku",
           "Which git command undoes the last commit but keeps its changes staged? Only the command.",
           has(r"git reset --soft HEAD(~1?|\^)"), "git reset --soft HEAD~1"),
    single("weekday", "haiku", "What day of the week was 1 March 2000? One word.", has(r"\bwednesday\b"),
           "Wednesday"),

    # --- normal coding ---
    single("binsearch", "sonnet", """This function should return the index of target in a sorted list, or -1. It hangs on some inputs. Fix it.

def find(xs, target):
    lo, hi = 0, len(xs)
    while lo < hi:
        mid = (lo + hi) // 2
        if xs[mid] < target:
            lo = mid
        elif xs[mid] > target:
            hi = mid
        else:
            return mid
    return -1""" + CODE_RULE, run_tests("""
        import random
        for n in range(0, 30):
            xs = sorted(random.sample(range(100), n))
            for t in range(-1, 101):
                assert find(xs, t) == (xs.index(t) if t in xs else -1), (xs, t)
    """), """```python
def find(xs, target):
    lo, hi = 0, len(xs)
    while lo < hi:
        mid = (lo + hi) // 2
        if xs[mid] < target: lo = mid + 1
        elif xs[mid] > target: hi = mid
        else: return mid
    return -1
```"""),
    single("intervals", "sonnet",
           "Write a Python function merge_intervals(intervals) that merges overlapping or touching [start, end] "
           "intervals (unsorted input) and returns them sorted. [[1,3],[3,5]] becomes [[1,5]]." + CODE_RULE,
           run_tests("""
        assert merge_intervals([]) == []
        assert merge_intervals([[1,3],[3,5]]) == [[1,5]]
        assert merge_intervals([[8,10],[1,3],[2,6],[15,18]]) == [[1,6],[8,10],[15,18]]
        assert merge_intervals([[1,4],[2,3]]) == [[1,4]]
        assert merge_intervals([[5,5],[1,2]]) == [[1,2],[5,5]]
    """), """```python
def merge_intervals(intervals):
    out = []
    for s, e in sorted(intervals):
        if out and s <= out[-1][1]: out[-1][1] = max(out[-1][1], e)
        else: out.append([s, e])
    return out
```"""),
    single("duration", "sonnet",
           "Write a Python function parse_duration(s) that turns strings like '1h30m', '45s', '2h5s', '1d2h' into a "
           "number of seconds (units d, h, m, s, each at most once, in that order). Raise ValueError on anything "
           "else, including '' and '5'." + CODE_RULE, run_tests("""
        assert parse_duration('1h30m') == 5400
        assert parse_duration('45s') == 45
        assert parse_duration('2h5s') == 7205
        assert parse_duration('1d2h') == 93600
        for bad in ['', '5', 'h', '1x', '1m1h', '1h1h', ' 1h', '1.5h']:
            try:
                parse_duration(bad)
            except ValueError:
                pass
            else:
                raise AssertionError(bad)
    """), """```python
import re
def parse_duration(s):
    m = re.fullmatch(r'(?:(\\d+)d)?(?:(\\d+)h)?(?:(\\d+)m)?(?:(\\d+)s)?', s)
    if not s or not m: raise ValueError(s)
    d, h, mi, se = (int(x or 0) for x in m.groups())
    return d*86400 + h*3600 + mi*60 + se
```"""),
    single("lru", "sonnet",
           "Write a Python class LRUCache(capacity) with get(key) (returns -1 when missing) and put(key, value), "
           "both O(1), evicting the least recently used key." + CODE_RULE, run_tests("""
        c = LRUCache(2)
        c.put(1, 1); c.put(2, 2)
        assert c.get(1) == 1
        c.put(3, 3)
        assert c.get(2) == -1
        c.put(4, 4)
        assert c.get(1) == -1 and c.get(3) == 3 and c.get(4) == 4
        c.put(3, 33); c.put(5, 5)
        assert c.get(4) == -1 and c.get(3) == 33
    """), """```python
from collections import OrderedDict
class LRUCache:
    def __init__(self, capacity): self.c, self.d = capacity, OrderedDict()
    def get(self, k):
        if k not in self.d: return -1
        self.d.move_to_end(k); return self.d[k]
    def put(self, k, v):
        self.d[k] = v; self.d.move_to_end(k)
        if len(self.d) > self.c: self.d.popitem(last=False)
```"""),

    # --- hard ---
    single("exprparse", "opus",
           "Write a Python function evaluate(s) that evaluates integer arithmetic with + - * /, parentheses, unary "
           "minus (also stacked, like '--3' and '2*-(1+1)') and arbitrary whitespace, without eval or exec. '/' "
           "truncates toward zero like C. * and / bind tighter than + and -, all left-associative." + CODE_RULE,
           run_tests("""
        cases = {'1+2*3': 7, '(1+2)*3': 9, '7/2': 3, '-7/2': -3, '7/-2': -3, '2--3': 5, '--3': 3,
                 '2*-(1+1)': -4, ' 10 - 2 - 3 ': 5, '100/10/5': 2, '-(2+3)*-4': 20, '2*3+4*5-6/2': 23,
                 '((((1))))': 1, '1-(-(-1))': 0, '-2*-2*-2': -8, '8/3*3': 6}
        for s, v in cases.items():
            assert evaluate(s) == v, (s, evaluate(s), v)
    """), """```python
def evaluate(s):
    t = [c for c in s if not c.isspace()]; p = [0]
    def peek(): return t[p[0]] if p[0] < len(t) else None
    def take(): p[0] += 1; return t[p[0]-1]
    def atom():
        if peek() == '-': take(); return -atom()
        if peek() == '(':
            take(); v = expr(); take(); return v
        n = ''
        while peek() and peek().isdigit(): n += take()
        return int(n)
    def term():
        v = atom()
        while peek() in ('*', '/'):
            op, r = take(), atom()
            v = v * r if op == '*' else (abs(v) // abs(r)) * (1 if (v < 0) == (r < 0) else -1)
        return v
    def expr():
        v = term()
        while peek() in ('+', '-'):
            op, r = take(), term(); v = v + r if op == '+' else v - r
        return v
    return expr()
```"""),
    single("pyoutput", "opus", """What exactly does this Python program print? Reply with only the printed output in a ``` block.

def make():
    fs = []
    for i in range(3):
        fs.append(lambda x, i=i: x * i if i else (yield x))
    return fs

def acc(v, bucket=[]):
    bucket.append(v)
    return len(bucket)

fs = make()
g = (f(2) for f in fs)
first = next(g)
print(type(first).__name__, list(first) if hasattr(first, '__next__') else first)
print([acc(f) for f in range(3)], acc(9))
nums = [1, 2, 3]
it = iter(nums)
print(list(zip(it, it)), list(it))
print(sum(len(list(f(1))) for f in fs[1:]), first.__class__ is g.__class__)""",
           has(r"generator \[2\]", r"\[1, 2, 3\] 4", r"\[\(1, 2\)\] \[\]", r"\b0 True\b"),
           "```\ngenerator [2]\n[1, 2, 3] 4\n[(1, 2)] []\n0 True\n```"),
    single("rangesum", "opus",
           "Implement a Python class RangeAdd(n) over an array of n zeros supporting add(l, r, v) (add v to every "
           "index in [l, r], inclusive) and total(l, r) (sum over [l, r], inclusive), both O(log n)." + CODE_RULE,
           run_tests("""
        import random
        random.seed(1)
        for n in (1, 2, 7, 50):
            ra, ref = RangeAdd(n), [0] * n
            for _ in range(400):
                l = random.randrange(n); r = random.randrange(l, n)
                if random.random() < .5:
                    v = random.randint(-9, 9); ra.add(l, r, v)
                    for k in range(l, r + 1): ref[k] += v
                else:
                    assert ra.total(l, r) == sum(ref[l:r + 1])
    """), """```python
class RangeAdd:
    def __init__(self, n): self.n, self.a, self.b = n, [0]*(n+2), [0]*(n+2)
    def _u(self, t, i, v):
        i += 1
        while i <= self.n + 1: t[i] += v; i += i & -i
    def _q(self, t, i):
        i += 1; s = 0
        while i > 0: s += t[i]; i -= i & -i
        return s
    def _pre(self, i): return self._q(self.a, i) * (i + 1) - self._q(self.b, i) if i >= 0 else 0
    def add(self, l, r, v):
        self._u(self.a, l, v); self._u(self.a, r+1, -v); self._u(self.b, l, v*l); self._u(self.b, r+1, -v*(r+1))
    def total(self, l, r): return self._pre(r) - self._pre(l-1)
```"""),
    single("median", "opus", """This should return the median of two sorted lists of numbers (at least one non-empty) as a float, in O(log(min(m, n))). It is wrong on some inputs and crashes on others. Fix it.

def median(a, b):
    m, n = len(a), len(b)
    lo, hi = 0, m
    while lo <= hi:
        i = (lo + hi) // 2
        j = (m + n + 1) // 2 - i
        al = a[i - 1] if i > 0 else float('-inf')
        ar = a[i] if i < m else float('inf')
        bl = b[j - 1] if j > 0 else float('-inf')
        br = b[j] if j < n else float('inf')
        if al <= br and bl <= ar:
            if (m + n) % 2:
                return max(al, bl)
            return (max(al, bl) + min(ar, br)) // 2
        elif al > br:
            hi = i - 1
        else:
            lo = i + 1""" + CODE_RULE, run_tests("""
        import random, statistics
        random.seed(3)
        for _ in range(3000):
            m, n = random.randint(0, 9), random.randint(0, 9)
            if m + n == 0: continue
            a = sorted(random.randint(-20, 20) for _ in range(m))
            b = sorted(random.randint(-20, 20) for _ in range(n))
            assert median(a, b) == statistics.median(a + b), (a, b, median(a, b))
    """), """```python
def median(a, b):
    if len(a) > len(b): a, b = b, a
    m, n = len(a), len(b)
    lo, hi = 0, m
    while lo <= hi:
        i = (lo + hi) // 2
        j = (m + n + 1) // 2 - i
        al = a[i - 1] if i > 0 else float('-inf')
        ar = a[i] if i < m else float('inf')
        bl = b[j - 1] if j > 0 else float('-inf')
        br = b[j] if j < n else float('inf')
        if al <= br and bl <= ar:
            if (m + n) % 2: return float(max(al, bl))
            return (max(al, bl) + min(ar, br)) / 2
        elif al > br: hi = i - 1
        else: lo = i + 1
```"""),
    single("palindrome", "opus",
           "Write a Python function next_palindrome(s) that takes a positive integer as a decimal string without "
           "leading zeros (up to 100000 digits) and returns the smallest palindrome strictly greater than it, as a "
           "string. It must run in linear time." + CODE_RULE, run_tests("""
        def slow(s):
            n = int(s) + 1
            while str(n) != str(n)[::-1]: n += 1
            return str(n)
        for k in list(range(1, 2500)) + [9999, 10001, 12921, 99899, 123456, 199991, 808, 1991]:
            assert next_palindrome(str(k)) == slow(str(k)), k
        big = '7' + '9' * 30000 + '8'
        assert next_palindrome(big) == '8' + '0' * 30000 + '8'
        assert next_palindrome('9' * 40001) == '1' + '0' * 40000 + '1'
        mid = '12' + '9' * 20001 + '35'
        assert next_palindrome(mid) == '13' + '0' * 20001 + '31'
    """), """```python
def next_palindrome(s):
    n = len(s)
    if set(s) == {'9'}: return '1' + '0' * (n - 1) + '1'
    half = s[:(n + 1) // 2]
    cand = half + half[:n // 2][::-1]
    if cand > s: return cand
    d = list(half); i = len(d) - 1
    while d[i] == '9': d[i] = '0'; i -= 1
    d[i] = str(int(d[i]) + 1)
    half = ''.join(d)
    return half + half[:n // 2][::-1]
```"""),

    # --- sound trivial, need real reasoning ---
    single("sneaky", "opus",
           "quick one: how many integers from 1 to 1000 inclusive are divisible by none of 6, 10 and 15? only the number",
           number(734), "734", ["sneaky"]),
    single("dominoes", "opus",
           "quick q, in how many ways can a 3x10 board be tiled with 2x1 dominoes? just the number",
           number(571), "571", ["sneaky"]),
    single("factorial", "opus", "last nonzero digit of 20! ? just the digit",
           number(4), "4", ["sneaky"]),

    # --- multi-turn: cache guard and follow-ups ---
    Case("guard-big", [
        Turn("Here is a module of helpers. Exactly one function does not do what its docstring says. Which one? "
             "Reply with only its name.\n\n```python\n" + HAYSTACK + "```", has(rf"\b{BUGGY}\b"), BUGGY, "sonnet"),
        Turn("unrelated: what's 17 * 23? only the number", number(391), "391", "haiku"),
        Turn("ok", lambda a: True, "", None),
    ], ["multi", "guard"], kept_at={1: True}),
]
