// Starts Node inside the Solo app: NodejsMobileRuntime.startNode(args, env).
// Each "NAME=value" in env is set for the process, then node::Start runs the
// server and returns only when Node exits — with its exit code. Node can start
// once per process, which is why it gets a process of its own (":node",
// SoloServerService). Node's stdout and stderr go to logcat, tag "stalkerweb".

#include <jni.h>
#include <android/log.h>
#include <pthread.h>
#include <unistd.h>
#include <cstdlib>
#include <cstring>
#include <string>
#include <vector>

#include "node.h"

namespace {

const char *TAG = "stalkerweb";

// Reads one end of a pipe and writes each line to logcat.
void *pipeToLogcat(void *arg) {
  const int fd = static_cast<int>(reinterpret_cast<intptr_t>(arg));
  const int priority = ANDROID_LOG_INFO;
  std::string line;
  char buf[1024];
  ssize_t n;
  while ((n = read(fd, buf, sizeof buf)) > 0) {
    for (ssize_t i = 0; i < n; i++) {
      if (buf[i] == '\n') {
        __android_log_write(priority, TAG, line.c_str());
        line.clear();
      } else {
        line.push_back(buf[i]);
      }
    }
  }
  if (!line.empty()) __android_log_write(priority, TAG, line.c_str());
  return nullptr;
}

// Points a file descriptor (stdout, stderr) at a pipe read on its own thread.
void redirectToLogcat(int target) {
  int fds[2];
  if (pipe(fds) != 0) return;
  dup2(fds[1], target);
  close(fds[1]);
  pthread_t thread;
  if (pthread_create(&thread, nullptr, pipeToLogcat, reinterpret_cast<void *>(static_cast<intptr_t>(fds[0]))) == 0) {
    pthread_detach(thread);
  }
}

std::vector<std::string> strings(JNIEnv *env, jobjectArray array) {
  std::vector<std::string> out;
  const jsize count = env->GetArrayLength(array);
  for (jsize i = 0; i < count; i++) {
    auto s = static_cast<jstring>(env->GetObjectArrayElement(array, i));
    const char *chars = env->GetStringUTFChars(s, nullptr);
    out.emplace_back(chars);
    env->ReleaseStringUTFChars(s, chars);
    env->DeleteLocalRef(s);
  }
  return out;
}

}  // namespace

extern "C" JNIEXPORT jint JNICALL
Java_com_stalkerweb_android_solo_NodejsMobileRuntime_startNode(JNIEnv *env, jobject /* this */,
                                                                jobjectArray jargs, jobjectArray jenv) {
  for (const std::string &pair : strings(env, jenv)) {
    const size_t eq = pair.find('=');
    if (eq == std::string::npos || eq == 0) continue;
    setenv(pair.substr(0, eq).c_str(), pair.substr(eq + 1).c_str(), 1);
  }

  setvbuf(stdout, nullptr, _IOLBF, 0);
  setvbuf(stderr, nullptr, _IONBF, 0);
  redirectToLogcat(STDOUT_FILENO);
  redirectToLogcat(STDERR_FILENO);

  // Node (libuv) wants every argument in one contiguous block of memory.
  const std::vector<std::string> args = strings(env, jargs);
  size_t size = 0;
  for (const std::string &a : args) size += a.size() + 1;
  char *block = static_cast<char *>(calloc(size, 1));
  std::vector<char *> argv;
  char *at = block;
  for (const std::string &a : args) {
    memcpy(at, a.c_str(), a.size());
    argv.push_back(at);
    at += a.size() + 1;
  }
  argv.push_back(nullptr);

  // Node keeps argv for the life of the process; the block is never freed.
  return node::Start(static_cast<int>(args.size()), argv.data());
}
