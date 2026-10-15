FROM eclipse-temurin:21-jdk-jammy
RUN groupadd --gid 10001 airjava && useradd --uid 10001 --gid 10001 --no-create-home --shell /usr/sbin/nologin airjava
WORKDIR /workspace
USER 10001:10001
ENV HOME=/tmp