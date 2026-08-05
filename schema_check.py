import sqlite3
conn = sqlite3.connect(r"C:\Users\Quang Nhi\.local\share\mimocode\mimocode.db")
c = conn.cursor()
c.execute("SELECT sql FROM sqlite_master WHERE type='table' OR type='index' ORDER BY type, name")
for row in c.fetchall():
    print(row[0])
conn.close()
