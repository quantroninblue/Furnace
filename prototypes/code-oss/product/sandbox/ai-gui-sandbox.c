// Unprivileged Linux command sandbox for agent commands (Auto permission mode).
// Landlock limits filesystem writes to the --write paths; reads and execution stay
// allowed. Unless --allow-network is given, Landlock denies TCP bind/connect and a
// seccomp filter denies non-Unix sockets and io_uring. Usage:
//   ai-gui-sandbox [--write PATH]... [--allow-network] -- COMMAND [ARG]...
//   ai-gui-sandbox --probe
#define _GNU_SOURCE
#include <errno.h>
#include <fcntl.h>
#include <linux/audit.h>
#include <linux/filter.h>
#include <linux/landlock.h>
#include <linux/seccomp.h>
#include <stddef.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <sys/prctl.h>
#include <sys/socket.h>
#include <sys/stat.h>
#include <sys/syscall.h>
#include <unistd.h>

#define FAIL 125
#ifndef LANDLOCK_ACCESS_FS_REFER
#define LANDLOCK_ACCESS_FS_REFER (1ULL << 13)
#endif
#ifndef LANDLOCK_ACCESS_FS_TRUNCATE
#define LANDLOCK_ACCESS_FS_TRUNCATE (1ULL << 14)
#endif

static int fail(const char *what) { fprintf(stderr, "ai-gui-sandbox: %s: %s\n", what, strerror(errno)); return FAIL; }

static int allow_writes(int ruleset, const char *path, __u64 dir_access, __u64 file_access) {
    int fd = open(path, O_PATH | O_CLOEXEC);
    if (fd < 0) return errno == ENOENT ? 0 : -1;  // Optional paths may be absent.
    struct stat info;
    if (fstat(fd, &info) < 0) { close(fd); return -1; }
    struct landlock_path_beneath_attr rule = { .allowed_access = S_ISDIR(info.st_mode) ? dir_access : file_access, .parent_fd = fd };
    int result = syscall(SYS_landlock_add_rule, ruleset, LANDLOCK_RULE_PATH_BENEATH, &rule, 0);
    close(fd);
    return result;
}

static int deny_network(void) {
    struct sock_filter filter[] = {
        BPF_STMT(BPF_LD | BPF_W | BPF_ABS, offsetof(struct seccomp_data, arch)),
#if defined(__x86_64__)
        BPF_JUMP(BPF_JMP | BPF_JEQ | BPF_K, AUDIT_ARCH_X86_64, 1, 0),
#elif defined(__aarch64__)
        BPF_JUMP(BPF_JMP | BPF_JEQ | BPF_K, AUDIT_ARCH_AARCH64, 1, 0),
#else
#error "Unsupported architecture"
#endif
        BPF_STMT(BPF_RET | BPF_K, SECCOMP_RET_KILL_PROCESS),
        BPF_STMT(BPF_LD | BPF_W | BPF_ABS, offsetof(struct seccomp_data, nr)),
#if defined(__x86_64__)
        BPF_JUMP(BPF_JMP | BPF_JGE | BPF_K, 0x40000000, 0, 1),  // Reject the x32 ABI.
        BPF_STMT(BPF_RET | BPF_K, SECCOMP_RET_ERRNO | EPERM),
#endif
        BPF_JUMP(BPF_JMP | BPF_JEQ | BPF_K, __NR_io_uring_setup, 0, 1),
        BPF_STMT(BPF_RET | BPF_K, SECCOMP_RET_ERRNO | EPERM),
        BPF_JUMP(BPF_JMP | BPF_JEQ | BPF_K, __NR_socket, 1, 0),
        BPF_STMT(BPF_RET | BPF_K, SECCOMP_RET_ALLOW),
        BPF_STMT(BPF_LD | BPF_W | BPF_ABS, offsetof(struct seccomp_data, args[0])),
        BPF_JUMP(BPF_JMP | BPF_JEQ | BPF_K, AF_UNIX, 0, 1),
        BPF_STMT(BPF_RET | BPF_K, SECCOMP_RET_ALLOW),
        BPF_STMT(BPF_RET | BPF_K, SECCOMP_RET_ERRNO | EACCES),
    };
    struct sock_fprog program = { .len = sizeof(filter) / sizeof(filter[0]), .filter = filter };
    return prctl(PR_SET_SECCOMP, SECCOMP_MODE_FILTER, &program);
}

int main(int argc, char **argv) {
    int probe = 0, network = 0, command = -1;
    const char *writes[64]; int count = 0;
    for (int i = 1; i < argc; i++) {
        if (!strcmp(argv[i], "--probe")) probe = 1;
        else if (!strcmp(argv[i], "--allow-network")) network = 1;
        else if (!strcmp(argv[i], "--write") && i + 1 < argc && count < 60) writes[count++] = argv[++i];
        else if (!strcmp(argv[i], "--") && i + 1 < argc) { command = i + 1; break; }
        else { fprintf(stderr, "ai-gui-sandbox: invalid arguments\n"); return FAIL; }
    }
    if (!probe && command < 0) { fprintf(stderr, "ai-gui-sandbox: missing command\n"); return FAIL; }
    int abi = syscall(SYS_landlock_create_ruleset, NULL, 0, LANDLOCK_CREATE_RULESET_VERSION);
    if (abi < 1) return fail("Landlock is unavailable");
    __u64 file_access = LANDLOCK_ACCESS_FS_WRITE_FILE | (abi >= 3 ? LANDLOCK_ACCESS_FS_TRUNCATE : 0);
    __u64 dir_access = file_access | LANDLOCK_ACCESS_FS_REMOVE_DIR | LANDLOCK_ACCESS_FS_REMOVE_FILE |
        LANDLOCK_ACCESS_FS_MAKE_CHAR | LANDLOCK_ACCESS_FS_MAKE_DIR | LANDLOCK_ACCESS_FS_MAKE_REG |
        LANDLOCK_ACCESS_FS_MAKE_SOCK | LANDLOCK_ACCESS_FS_MAKE_FIFO | LANDLOCK_ACCESS_FS_MAKE_BLOCK |
        LANDLOCK_ACCESS_FS_MAKE_SYM | (abi >= 2 ? LANDLOCK_ACCESS_FS_REFER : 0);
    struct landlock_ruleset_attr attr = { .handled_access_fs = dir_access };
#ifdef LANDLOCK_ACCESS_NET_CONNECT_TCP
    if (!network && abi >= 4) attr.handled_access_net = LANDLOCK_ACCESS_NET_BIND_TCP | LANDLOCK_ACCESS_NET_CONNECT_TCP;
#endif
    int ruleset = syscall(SYS_landlock_create_ruleset, &attr, sizeof(attr), 0);
    if (ruleset < 0) return fail("cannot create Landlock ruleset");
    const char *always[] = { "/dev/null", "/dev/zero", "/dev/full", "/dev/tty", "/dev/pts", "/dev/shm" };
    for (size_t i = 0; i < sizeof(always) / sizeof(always[0]); i++)
        if (allow_writes(ruleset, always[i], dir_access, file_access) < 0) return fail(always[i]);
    for (int i = 0; i < count; i++)
        if (allow_writes(ruleset, writes[i], dir_access, file_access) < 0) return fail(writes[i]);
    if (prctl(PR_SET_NO_NEW_PRIVS, 1, 0, 0, 0) < 0) return fail("no_new_privs");
    if (syscall(SYS_landlock_restrict_self, ruleset, 0) < 0) return fail("cannot apply Landlock");
    close(ruleset);
    if (!network && deny_network() < 0) return fail("cannot apply seccomp");
    if (probe) { printf("ok landlock-abi=%d network=%s\n", abi, network ? "allowed" : "denied"); return 0; }
    execvp(argv[command], &argv[command]);
    return fail(argv[command]);
}
