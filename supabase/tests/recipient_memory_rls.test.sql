BEGIN;
SELECT plan(4);

SELECT has_table('public', 'recipients', 'recipients table exists');
SELECT has_table('public', 'user_memories', 'user memories table exists');
SELECT policies_are('public', 'recipients', ARRAY['recipient_user_isolation'], 'recipient RLS policy exists');
SELECT policies_are('public', 'user_memories', ARRAY['user_memory_isolation'], 'memory RLS policy exists');

SELECT * FROM finish();
ROLLBACK;
