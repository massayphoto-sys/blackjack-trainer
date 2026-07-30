#!/bin/sh
open "$(dirname "$0")/index.html" 2>/dev/null || xdg-open "$(dirname "$0")/index.html"
