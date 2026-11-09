# One image runs everything: the web app (default command), the worker, and one-off migrations.
FROM node:22-slim AS build
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci
COPY . .
RUN npx next build

FROM node:22-slim
ENV NODE_ENV=production NEXT_TELEMETRY_DISABLED=1
WORKDIR /app
COPY --from=build /app ./
USER node
EXPOSE 3000
# web:      npm run start
# worker:   npm run worker
# migrate:  npm run migrate
CMD ["npm", "run", "start"]
