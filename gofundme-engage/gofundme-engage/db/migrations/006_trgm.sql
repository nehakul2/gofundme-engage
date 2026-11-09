-- Typo-tolerant search: word_similarity() compares letter triples, so "progrm" still finds "program".
CREATE EXTENSION IF NOT EXISTS pg_trgm;
