/* errstub.c: Minimal stand-ins for the error-reporting symbols declared in
 * tworld/err.h ("warn_", "errmsg_", "die_", and the "err_cfile_"/
 * "err_lineno_" globals used by the warn/errmsg/die macros).
 *
 * The real implementation lives in tworld/err.c, but that file may pull in
 * GUI/OS dependencies we don't want in this pure-logic harness, so we
 * provide our own tiny non-fatal (except die_) versions here instead.
 */

#include <stdio.h>
#include <stdarg.h>
#include <stdlib.h>

char const *err_cfile_ = NULL;
unsigned long err_lineno_ = 0;

void warn_(char const *fmt, ...)
{
    va_list args;
    va_start(args, fmt);
    fprintf(stderr, "warn: ");
    vfprintf(stderr, fmt, args);
    fprintf(stderr, "\n");
    va_end(args);
}

void errmsg_(char const *prefix, char const *fmt, ...)
{
    va_list args;
    va_start(args, fmt);
    if (prefix)
        fprintf(stderr, "%s: ", prefix);
    vfprintf(stderr, fmt, args);
    fprintf(stderr, "\n");
    va_end(args);
}

void die_(char const *fmt, ...) __attribute__((noreturn));

void die_(char const *fmt, ...)
{
    va_list args;
    va_start(args, fmt);
    fprintf(stderr, "fatal: ");
    vfprintf(stderr, fmt, args);
    fprintf(stderr, "\n");
    va_end(args);
    exit(1);
}
