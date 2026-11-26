#!/bin/sh
exec swift "$(dirname "$0")/replay-iac.swift" --notes-only "$@"
