/// Git's empty tree. A root commit's parent side, so `<root>^` is never asked
/// for. Its own module so tests that mock `./git` wholesale still see it.
export const EMPTY_TREE = "4b825dc642cb6eb9a060e54bf8d69288fbee4904";
