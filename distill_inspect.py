import sqlite3, json, time

DB = r"C:\Users\Quang Nhi\.local\share\mimocode\mimocode.db"
conn = sqlite3.connect(DB)
conn.row_factory = sqlite3.Row
c = conn.cursor()

# 1. Recent sessions (last 30 days)
cutoff = int((time.time() - 30*86400) * 1000)
print("=== RECENT SESSIONS (last 30 days) ===")
c.execute("SELECT id, title, time_created, directory FROM session WHERE time_created > ? ORDER BY time_created DESC", (cutoff,))
sessions = c.fetchall()
for s in sessions:
    ts = time.strftime('%Y-%m-%d %H:%M', time.localtime(s['time_created']/1000))
    print(f"  {s['id']} | {ts} | {s['title'][:80]}")
    print(f"    dir: {s['directory']}")

print(f"\nTotal: {len(sessions)} sessions in last 30 days\n")

if not sessions:
    print("No recent sessions found.")
    conn.close()
    exit()

sids = [s['id'] for s in sessions]
placeholders = ','.join('?'*len(sids))

# 2. Most used tools
print("=== MOST USED TOOLS (assistant tool calls) ===")
c.execute(f"""
    SELECT json_extract(p.data, '$.tool') as tool, count(*) as n
    FROM message m
    JOIN part p ON p.message_id = m.id
    WHERE json_extract(m.data, '$.role') = 'assistant'
      AND json_extract(p.data, '$.type') = 'tool'
      AND m.session_id IN ({placeholders})
    GROUP BY tool
    ORDER BY n DESC
    LIMIT 30
""", sids)
for row in c.fetchall():
    print(f"  {row[0]}: {row[1]}")

# 3. Top tool input patterns
print("\n=== TOP TOOL INPUT PATTERNS (top 40) ===")
c.execute(f"""
    SELECT json_extract(p.data, '$.tool') as tool,
           substr(json_extract(p.data, '$.state.input'), 1, 200) as input_preview,
           count(*) as n
    FROM message m
    JOIN part p ON p.message_id = m.id
    WHERE json_extract(m.data, '$.role') = 'assistant'
      AND json_extract(p.data, '$.type') = 'tool'
      AND m.session_id IN ({placeholders})
    GROUP BY tool, input_preview
    ORDER BY n DESC
    LIMIT 40
""", sids)
for row in c.fetchall():
    print(f"  [{row[0]}] x{row[2]} | {row[1]}")

# 4. User messages with repeat keywords
print("\n=== USER MESSAGES WITH REPEAT KEYWORDS ===")
c.execute(f"""
    SELECT m.id, substr(json_extract(m.data, '$.content'), 1, 400)
    FROM message m
    WHERE json_extract(m.data, '$.role') = 'user'
      AND m.session_id IN ({placeholders})
      AND (
        json_extract(m.data, '$.content') LIKE '%again%'
        OR json_extract(m.data, '$.content') LIKE '%repeat%'
        OR json_extract(m.data, '$.content') LIKE '%like last%'
        OR json_extract(m.data, '$.content') LIKE '%same as%'
        OR json_extract(m.data, '$.content') LIKE '%the usual%'
        OR json_extract(m.data, '$.content') LIKE '%mỗi lần%'
        OR json_extract(m.data, '$.content') LIKE '%như lần%'
        OR json_extract(m.data, '$.content') LIKE '%lặp lại%'
        OR json_extract(m.data, '$.content') LIKE '%giống trước%'
        OR json_extract(m.data, '$.content') LIKE '%cũng%'
        OR json_extract(m.data, '$.content') LIKE '%tiếp%'
      )
    LIMIT 30
""", sids)
for row in c.fetchall():
    print(f"  {row[0]}: {row[1]}")

# 5. Write/edit file patterns
print("\n=== FILE OPERATIONS (Write/Edit) - Most targeted files ===")
c.execute(f"""
    SELECT json_extract(p.data, '$.tool') as tool,
           json_extract(json_extract(p.data, '$.state.input'), '$.file_path') as fp,
           count(*) as n
    FROM message m
    JOIN part p ON p.message_id = m.id
    WHERE json_extract(m.data, '$.role') = 'assistant'
      AND json_extract(p.data, '$.type') = 'tool'
      AND json_extract(p.data, '$.tool') IN ('write', 'edit')
      AND m.session_id IN ({placeholders})
    GROUP BY tool, fp
    ORDER BY n DESC
    LIMIT 40
""", sids)
for row in c.fetchall():
    print(f"  [{row[0]}] x{row[2]} | {row[1]}")

# 6. Grep patterns
print("\n=== GREP PATTERNS ===")
c.execute(f"""
    SELECT json_extract(json_extract(p.data, '$.state.input'), '$.pattern') as pat,
           count(*) as n
    FROM message m
    JOIN part p ON p.message_id = m.id
    WHERE json_extract(m.data, '$.role') = 'assistant'
      AND json_extract(p.data, '$.type') = 'tool'
      AND json_extract(p.data, '$.tool') = 'grep'
      AND m.session_id IN ({placeholders})
    GROUP BY pat
    ORDER BY n DESC
    LIMIT 25
""", sids)
for row in c.fetchall():
    print(f"  x{row[1]} | {row[0]}")

# 7. Glob patterns
print("\n=== GLOB PATTERNS ===")
c.execute(f"""
    SELECT json_extract(json_extract(p.data, '$.state.input'), '$.pattern') as pat,
           count(*) as n
    FROM message m
    JOIN part p ON p.message_id = m.id
    WHERE json_extract(m.data, '$.role') = 'assistant'
      AND json_extract(p.data, '$.type') = 'tool'
      AND json_extract(p.data, '$.tool') = 'glob'
      AND m.session_id IN ({placeholders})
    GROUP BY pat
    ORDER BY n DESC
    LIMIT 25
""", sids)
for row in c.fetchall():
    print(f"  x{row[1]} | {row[0]}")

# 8. Bash command patterns
print("\n=== BASH COMMAND PATTERNS ===")
c.execute(f"""
    SELECT substr(json_extract(json_extract(p.data, '$.state.input'), '$.command'), 1, 150) as cmd,
           count(*) as n
    FROM message m
    JOIN part p ON p.message_id = m.id
    WHERE json_extract(m.data, '$.role') = 'assistant'
      AND json_extract(p.data, '$.type') = 'tool'
      AND json_extract(p.data, '$.tool') = 'bash'
      AND m.session_id IN ({placeholders})
    GROUP BY cmd
    ORDER BY n DESC
    LIMIT 30
""", sids)
for row in c.fetchall():
    print(f"  x{row[1]} | {row[0]}")

# 9. Repeated session titles / themes
print("\n=== SESSION THEMES (titles) ===")
c.execute(f"""
    SELECT title, count(*) as n
    FROM session
    WHERE time_created > ?
    GROUP BY title
    ORDER BY n DESC
    LIMIT 20
""", (cutoff,))
for row in c.fetchall():
    if row[1] > 1:
        print(f"  x{row[1]} | {row[0]}")

# 10. Tasks across recent sessions
print("\n=== TASKS ===")
c.execute(f"""
    SELECT t.session_id, t.summary, t.status, count(*) as n
    FROM task t
    WHERE t.session_id IN ({placeholders})
    GROUP BY t.summary
    ORDER BY n DESC
    LIMIT 20
""", sids)
for row in c.fetchall():
    print(f"  [{row[2]}] x{row[3]} | {row[1][:100]}")

conn.close()
