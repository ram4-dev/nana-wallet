BEGIN;
SELECT plan(5);

SELECT has_table('public', 'conversations', 'conversations table exists');
SELECT has_table('public', 'conversation_state', 'conversation state table exists');
SELECT policies_are('public', 'conversations', ARRAY['conversation_user_isolation'], 'conversation RLS policy exists');
SELECT policies_are('public', 'conversation_transfer_attempts', ARRAY['conversation_transfer_user_isolation'], 'transfer RLS policy exists');
SELECT policies_are('public', 'conversation_live_leases', ARRAY['conversation_live_lease_user_isolation'], 'live lease RLS policy exists');

SELECT * FROM finish();
ROLLBACK;
