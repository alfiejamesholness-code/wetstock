-- The "unit" column was restricted to a fixed list (Keg/Bottle/Can/Case/
-- Bag-in-box/Other) via a database enum, which doesn't know about the new
-- case-size options. This switches it to plain text instead, so any unit
-- name works without needing a database change every time. Safe to run
-- more than once.

alter table products alter column unit type text using unit::text;
alter table products alter column unit set default 'Bottle';
