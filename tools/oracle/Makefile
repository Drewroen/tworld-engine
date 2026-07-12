# Makefile for the C oracle harness.
#
# Compiles the real, unmodified Tile World reference logic sources
# (random.c, encoding.c, lxlogic.c, mslogic.c) together with our own
# harness.c and errstub.c into a standalone `harness` binary. No GUI/OS
# libraries are linked -- these logic files have zero such dependencies.

SRC = ../../../tworld
CFLAGS = -O0 -g -I$(SRC) -DNDEBUG -Wall

harness: harness.c errstub.c $(SRC)/random.c $(SRC)/encoding.c $(SRC)/lxlogic.c $(SRC)/mslogic.c
	cc $(CFLAGS) -o harness $^

clean:
	rm -f harness

.PHONY: clean
