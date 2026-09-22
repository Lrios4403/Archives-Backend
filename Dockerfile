# use the official Bun image
# see all versions at https://hub.docker.com/r/oven/bun/tags
FROM oven/bun:latest AS base
WORKDIR /usr/src/app

# install dependencies into temp directory
# this will cache them and speed up future builds
FROM base AS install
RUN mkdir -p /temp/dev
COPY package.json bun.lock /temp/dev/
RUN cd /temp/dev && bun install --frozen-lockfile

# install with --production (exclude devDependencies)
RUN mkdir -p /temp/prod
COPY package.json bun.lock /temp/prod/
RUN cd /temp/prod && bun install --frozen-lockfile --production

# copy node_modules from temp directory
# then copy all (non-ignored) project files into the image
FROM base AS prerelease
COPY --from=install /temp/dev/node_modules node_modules
COPY . .

# [optional] tests
#
# `bun test` runs the 14 *.test.ts files. Several of them read WARC fixtures from
# a sibling directory that is outside this repository, so they do not all pass in
# a bare clone — see the Tests section of README.md before turning this on.
#ENV NODE_ENV=production
#RUN bun test

# copy production dependencies and source code into final image
FROM base AS release
COPY --from=install /temp/prod/node_modules node_modules

# The whole tree, not a file list.
#
# This used to be `COPY index.ts` plus `ENTRYPOINT ["bun", "run", "index.ts"]`,
# which was `bun init` scaffolding that no one revisited: there is no index.ts in
# this project and never was, so the build failed at that layer and the image was
# never usable. Nothing noticed because the compose stack bind-mounts the source
# over a stock oven/bun image instead of building this file.
#
# A list would not work even with the name corrected. webserver.ts imports db.ts,
# routes/*.tsx, parser/* and db.types, and reset_database() reads db/setup.sql
# from disk at runtime. .dockerignore is what keeps this from dragging in
# node_modules and the archives.
COPY . .

# warcs/ is excluded from the build context (it holds the archives), so it does
# not arrive with the COPY above — but webserver.ts warms folder stats from
# "./warcs/" at boot and the status route stats it per request. Create it empty
# and let a volume or bind mount cover it at runtime.
RUN mkdir -p warcs && chown bun:bun warcs

USER bun
EXPOSE 3000/tcp

# The HTTP API. The parser is the other half of this image and is a separate,
# long-running process rather than a route — start it by overriding the
# entrypoint:
#
#   docker run --entrypoint bun <image> run parser.ts
#
# Both read the same DATABASE_URL and the same warcs/ directory.
ENTRYPOINT [ "bun", "run", "webserver.ts" ]
