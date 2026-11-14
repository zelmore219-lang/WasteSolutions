-- Run as postgres in your private Supabase SQL Editor AFTER creating and verifying
-- your own user in Firebase Authentication. Never put a password in this query.
DO $corewaste_owner$
DECLARE uid text := 'PASTE_FIREBASE_USER_UID_HERE';
BEGIN
 IF uid='PASTE_FIREBASE_USER_UID_HERE' OR uid !~ '^[A-Za-z0-9_-]{10,128}$' THEN
  RAISE EXCEPTION 'Replace the UID placeholder with the exact user UID copied from your Firebase project.';
 END IF;
 IF EXISTS(SELECT 1 FROM employees WHERE role='owner') THEN
  RAISE EXCEPTION 'An owner already exists. This helper will not replace or take over that account.';
 END IF;
 IF EXISTS(SELECT 1 FROM employees WHERE firebase_uid=uid OR username='owner') THEN
  RAISE EXCEPTION 'The identity/username already belongs to an employee. Review that mapping first.';
 END IF;
 INSERT INTO employees(firebase_uid,username,display_name,role) VALUES(uid,'owner','Company owner','owner');
END $corewaste_owner$;
