# image เดียวใช้ได้ทั้ง API และงาน migrate · ไม่มี state ในเครื่อง จึงรันกี่ตัวก็ได้หลัง load balancer
#   API    : node dist/main.js (ค่าเริ่มต้น)
#   Migrate: node /app/packages/db/scripts/migrate.ts (รันก่อนเปลี่ยนเวอร์ชันทุกครั้ง)
# build จากรากของ repo: docker build -f infra/docker/api.Dockerfile .
FROM node:22-bookworm AS build
WORKDIR /app
RUN npm install --global pnpm@10.34.5
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
COPY apps/api/package.json apps/api/package.json
COPY packages/db/package.json packages/db/package.json
COPY packages/core/package.json packages/core/package.json
RUN pnpm --filter @rental/api... install --frozen-lockfile
COPY packages packages
COPY apps/api apps/api
RUN pnpm --filter @rental/api build

# dependency สำหรับรันเท่านั้น · คงโครง workspace เพราะ @rental/db และ @rental/core เป็นไฟล์ .ts
# Node 22 ตัด type ให้เฉพาะไฟล์นอก node_modules · symlink ของ pnpm ชี้ไป packages/* จึงใช้ได้
FROM node:22-bookworm-slim AS deps
WORKDIR /app
RUN npm install --global pnpm@10.34.5
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
COPY apps/api/package.json apps/api/package.json
COPY packages/db/package.json packages/db/package.json
COPY packages/core/package.json packages/core/package.json
RUN pnpm --filter @rental/api... install --frozen-lockfile --prod

FROM node:22-bookworm-slim AS runtime
ENV NODE_ENV=production API_PORT=4100
WORKDIR /app
COPY --from=deps --chown=node:node /app ./
COPY --from=build --chown=node:node /app/apps/api/dist ./apps/api/dist
COPY --chown=node:node packages/db/src ./packages/db/src
COPY --chown=node:node packages/db/scripts ./packages/db/scripts
COPY --chown=node:node packages/db/migrations ./packages/db/migrations
COPY --chown=node:node packages/core/src ./packages/core/src
USER node
WORKDIR /app/apps/api
EXPOSE 4100
HEALTHCHECK --interval=10s --timeout=3s --retries=3 CMD node -e "fetch('http://127.0.0.1:4100/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"
CMD ["node", "dist/main.js"]
