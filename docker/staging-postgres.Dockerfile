FROM postgres:16-alpine
COPY connections-docs/insforge-schema.sql /connections-schema/baseline.sql
COPY migrations /connections-schema/migrations
COPY docker/staging-schema.sql /docker-entrypoint-initdb.d/10-connections-staging.sql
