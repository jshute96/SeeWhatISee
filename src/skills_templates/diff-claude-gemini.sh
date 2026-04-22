#!/bin/bash

# Start diffs in `meld` of the corresponding skills for claude and gemini.

DIR=$(dirname "$0")

meld "$DIR"/{claude,gemini}.see.md &
meld "$DIR"/{claude,gemini}.watch.md &
