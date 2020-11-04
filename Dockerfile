# build stage
FROM node:alpine as build-stage
WORKDIR /app
RUN yarn global add @quasar/cli
COPY ui/package.json ./
RUN yarn
COPY . .
WORKDIR ui/dev/
RUN yarn
WORKDIR ui/dev

CMD ["quasar", "dev", "-H", "0.0.0.0"]

# production stage
#FROM iamfreee/docker-nginx-static-spa:latest as production-stage
#COPY --from=build-stage /app/dist/spa /var/www/html
#EXPOSE 80
#CMD ["nginx", "-g", "daemon off;"]
