# Node 24 executes the TypeScript directly — there is no build step to run
# here, and adding one would undo the reason the project has none.
FROM node:24-alpine

WORKDIR /app

# Manifests first so a code change does not reinstall the dependency tree.
# npm ci installs exactly the lockfile, never a resolved-today version.
COPY offchain/package.json offchain/package-lock.json ./offchain/
RUN cd offchain && npm ci --omit=dev

# Both trees, at these exact relative positions: main.ts resolves the static
# root as ../../web from src/, so web/ has to sit beside offchain/.
COPY offchain ./offchain
COPY web ./web

# Not a secret and not authority — the process reads its real settings from
# the environment. This only spares the operator one more variable.
ENV PORT=8787
EXPOSE 8787

# The volume is mounted here; the database must live on it and nowhere else.
VOLUME ["/data"]

# Exec form, so SIGTERM reaches node itself rather than a shell. main.ts
# closes the worker, the server and the database on it — a stop mid-epoch
# then leaves the journal consistent instead of half-written.
CMD ["node", "offchain/src/main.ts"]
