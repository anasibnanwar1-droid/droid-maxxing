const exit = () => process.exit(0);

process.once('SIGINT', exit);
process.once('SIGTERM', exit);
process.stdin.resume();
process.stdin.once('end', exit);
