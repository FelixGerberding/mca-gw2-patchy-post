# canvas needs cairo/pango at runtime, so this runs as a container image
# Lambda rather than a zip - a layer with prebuilt native bits is the fragile
# way to do the same thing.
FROM public.ecr.aws/lambda/nodejs:22

RUN dnf install -y cairo pango libjpeg-turbo giflib librsvg2 && dnf clean all

WORKDIR ${LAMBDA_TASK_ROOT}

COPY package.json package-lock.json ./
RUN npm ci --omit=dev

COPY index.js ./
COPY src ./src
COPY fonts ./fonts
COPY boss_icons ./boss_icons
COPY group_icons ./group_icons
COPY background.jpg cm_badge.png ./

CMD [ "src/handler.handler" ]
