---
name: ruby-best-practices
description: Ruby and Rails best practices. Use when reading or editing any .rb, .rake, or .erb file.
paths: ["**/*.rb", "**/*.rake", "**/*.erb"]
---

# Ruby best practices

Apply the **model-the-domain** and **minimize-reader-load** principle skills first. Where the codebase uses Sorbet, also apply **type-system-discipline**.

| Rule | Summary |
|------|---------|
| `attr_reader` over ivars | In a new class, read every ivar through an `attr_reader` with a Sorbet `sig`. Touch `@foo` only in the constructor. Mark the reader `private` unless it's public interface. This holds even where sibling code reads ivars directly. |
| No endless defs | Write `def ... end`, never `def foo = bar`, even for one-liners. |
| No side-effect ivars | A method returns its result. It never sets an ivar that another method reads later. Memoise in the accessor: `@x ||= compute`. |
| Memoise falsy values safely | `||=` recomputes when the result is `nil` or `false`. Use `return @x if defined?(@x)` when either is a valid result. |
| Small classes and methods | Classes ≤ 100 lines, methods ≤ 5 lines, ≤ 4 parameters (an options hash counts as one). Break a limit only with a stated reason. |
| Keyword arguments | Use keywords when a method takes two or more values of the same type, or any boolean, so the call site reads without the definition. |
| Enums over symbols and strings | Model a closed set of variants with `T::Enum`, not bare symbols, strings, or boolean pairs. |
| Exhaustive `case` | Close every `case` over a `T::Enum` or union with `else T.absurd(x)` so a new variant fails type checking. |
| Structs over hashes | Data that travels together is a `T::Struct` or a small class, not a hash with known keys passed between methods. |
| No lying casts | `T.unsafe`, `T.cast`, and `T.must` silence the checker. Use them only after the value has been validated, never to make a type error go away. |
| Parse at the boundary | Turn params, JSON, and job arguments into typed domain objects where they enter. Code past the boundary trusts the types and doesn't re-check them. See the **boundary-discipline** principle skill. |
| Null object over `nil` checks | When many callers branch on `nil`, return an object that answers the same messages instead. |
| Tell, don't ask | Send an object a message to do the work. Don't pull its data out and decide for it. Avoid chains like `user.account.settings.theme`. |
| Name the variation, don't pass it in a block | Don't write a method whose purpose is to accept a caller's block so several callers can share a skeleton. Return a value the caller can keep working with (a relation, collection, or object), or give the varying part a name: a scope, a method, or a small object. Blocks stay fine for iteration, resource wrappers (`transaction`, `with_lock`, `File.open`), and DSLs. |
| One object per controller action | A controller action builds one object and hands it to the view. The work lives in a model, query object, or form object. |
| No queries in views or helpers | Views and helpers read preloaded data passed in as one instance variable or locals. A query in a partial is an N+1. |
| Behaviour out of callbacks | Keep business rules out of `before_*`/`after_*` chains. Call them explicitly from the object that owns the operation. |
| Tests grouped by method | One `context "#method"` (or `".method"`) per method with 2+ tests, one level deep. Test names state only what they assert. A single test stays bare as `test "#method - what it asserts"`. Order contexts to match the source file, and tests happy path → edge → error. |

Examples: `references/patterns.md`.
