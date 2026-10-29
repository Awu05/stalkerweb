// Starts Node inside the Solo app: NodejsMobileRuntime.startNode(args, env).
// Each "NAME=value" in env is set for the process, then node::Start runs the
// server and returns only when Node exits — with its exit code. Node can start
// once per process, which is why it gets a process of its own (":node",
// SoloServerService). Node's stdout goes to logcat at INFO and its stderr at
// ERROR, tag "stalkerweb", a line over ~4000 bytes in several entries; when
// Node exits, what's still in the pipes is written out before this returns.

#include <jni.h>
#include <android/log.h>
#include <errno.h>
#include <fcntl.h>
#include <pthread.h>
#include <time.h>
#include <unistd.h>
#include <algorithm>
#include <cstdio>
#include <cstdlib>
#include <cstring>
#include <string>
#include <vector>

#include "node.h"

namespace {

const char *TAG = "stalkerweb";
// logcat cuts an entry at about 4 KB: a longer line goes out in parts.
const size_t MAX_ENTRY = 4000;

// The threads that read stdout and stderr, so what's left in the pipes can be
// waited for when Node exits (the process is killed right after).
pthread_mutex_t readersLock = PTHREAD_MUTEX_INITIALIZER;
pthread_cond_t readersDone = PTHREAD_COND_INITIALIZER;
int readers = 0;

struct Pipe {
  int fd;
  int priority;   // stdout INFO, stderr ERROR
};

// Writes `line` to logcat, in parts of at most MAX_ENTRY bytes, not cutting a
// UTF-8 character in two.
void writeLine(int priority, const std::string &line) {
  size_t at = 0;
  do {
    size_t n = std::min(MAX_ENTRY, line.size() - at);
    if (at + n < line.size()) {
      size_t k = n;
      while (k > 0 && (static_cast<unsigned char>(line[at + k]) & 0xC0) == 0x80) k--;
      if (k > 0) n = k;
    }
    __android_log_write(priority, TAG, line.substr(at, n).c_str());
    at += n;
  } while (at < line.size());
}

// Reads one end of a pipe and writes each line to logcat, until the pipe ends.
void *pipeToLogcat(void *arg) {
  const Pipe p = *static_cast<Pipe *>(arg);
  delete static_cast<Pipe *>(arg);
  std::string line;
  char buf[1024];
  ssize_t n;
  while ((n = read(p.fd, buf, sizeof buf)) > 0 || (n < 0 && errno == EINTR)) {
    for (ssize_t i = 0; i < n; i++) {
      if (buf[i] == '\n') {
        writeLine(p.priority, line);
        line.clear();
      } else {
        line.push_back(buf[i]);
        if (line.size() >= 4 * MAX_ENTRY) { writeLine(p.priority, line); line.clear(); }   // no newline in sight
      }
    }
  }
  if (!line.empty()) writeLine(p.priority, line);
  close(p.fd);
  pthread_mutex_lock(&readersLock);
  readers--;
  pthread_cond_broadcast(&readersDone);
  pthread_mutex_unlock(&readersLock);
  return nullptr;
}

// Points a file descriptor (stdout, stderr) at a pipe read on its own thread.
void redirectToLogcat(int target, int priority) {
  int fds[2];
  if (pipe(fds) != 0) return;
  dup2(fds[1], target);
  close(fds[1]);
  pthread_t thread;
  auto *p = new Pipe{fds[0], priority};
  pthread_mutex_lock(&readersLock);
  readers++;
  pthread_mutex_unlock(&readersLock);
  if (pthread_create(&thread, nullptr, pipeToLogcat, p) == 0) {
    pthread_detach(thread);
  } else {
    delete p;
    close(fds[0]);
    pthread_mutex_lock(&readersLock);
    readers--;
    pthread_mutex_unlock(&readersLock);
  }
}

// Node has exited: ends stdout and stderr (pointed at /dev/null now), so the
// readers see the end of their pipes, and waits up to 2 s for them to write
// out what was left — the process is killed once this returns.
void drainLogs() {
  fflush(stdout);
  fflush(stderr);
  const int devnull = open("/dev/null", O_WRONLY);
  if (devnull >= 0) {
    dup2(devnull, STDOUT_FILENO);
    dup2(devnull, STDERR_FILENO);
    close(devnull);
  } else {
    close(STDOUT_FILENO);
    close(STDERR_FILENO);
  }
  timespec until{};
  clock_gettime(CLOCK_REALTIME, &until);
  until.tv_sec += 2;
  pthread_mutex_lock(&readersLock);
  while (readers > 0) {
    if (pthread_cond_timedwait(&readersDone, &readersLock, &until) != 0) break;
  }
  pthread_mutex_unlock(&readersLock);
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
  redirectToLogcat(STDOUT_FILENO, ANDROID_LOG_INFO);
  redirectToLogcat(STDERR_FILENO, ANDROID_LOG_ERROR);

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
  const int code = node::Start(static_cast<int>(args.size()), argv.data());
  drainLogs();
  return code;
}
