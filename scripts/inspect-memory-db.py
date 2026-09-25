import sqlite3
import os
# 这个是用来测试的，不会在app里运行，是AI写来读取memory，看聊天记录是否写入了记忆
p = os.path.expandvars(r'%APPDATA%\alice-ai-app\alice-thoughts.sqlite')
c = sqlite3.connect(p)
cur = c.cursor()

tables = [r[0] for r in cur.execute(
    "SELECT name FROM sqlite_master WHERE type='table'").fetchall()]
print('tables:', tables)

for t in ('thoughts', 'long_term_memories'):
    if t in tables:
        print(t, 'count =', cur.execute(
            'SELECT COUNT(*) FROM ' + t).fetchone()[0])

for t, col in (('thoughts', 'embedding_local'),
               ('thoughts', 'embedding_openai'),
               ('long_term_memories', 'embedding_local'),
               ('long_term_memories', 'embedding_openai')):
    if t in tables:
        try:
            print(f'{t}.{col} NOT NULL =', cur.execute(
                f'SELECT COUNT(*) FROM {t} WHERE {col} IS NOT NULL'
            ).fetchone()[0])
        except Exception as e:
            print(t, col, 'ERR:', e)

if 'conversation_summaries' in tables:
    print('conversation_summaries count =', cur.execute(
        'SELECT COUNT(*) FROM conversation_summaries').fetchone()[0])

if 'migration_flags' in tables:
    flags = dict(cur.execute(
        'SELECT flag_name, completed FROM migration_flags').fetchall())
    print('migration_flags:', flags)
    if 'doubao_vector_dimension' in flags:
        print('>>> 实际生效的 doubao 向量维度 =', flags['doubao_vector_dimension'])

if 'thoughts' in tables:
    rows = cur.execute(
        'SELECT role, substr(text_content,1,60), created_at '
        'FROM thoughts ORDER BY created_at DESC LIMIT 5').fetchall()
    print('latest thoughts:', rows)

c.close()
