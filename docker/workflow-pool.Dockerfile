FROM open-flow-image

COPY docker/workflow-pool.mjs src/server/workflow-runtime.ts /app/
CMD ["flock", "--no-fork", "/data/open-flow/.pool.lock", "node", "workflow-pool.mjs"]
