# Course restriction fixture provenance

Captured on 2026-10-18 from the local Moodle 5.0.10+ lab as its seeded student at `/course/view.php?id=16`. `course-restrictions.html` retains the original section containing activity 150, Locked Task, with its rendered availability condition. Unrelated activity rows, navigation and scripts were discarded. The lab origin is replaced with `https://school.example.edu` and session keys with `fixture`.

Moodle's course-state exporter supplies `uservisible: false` and `hascmrestrictions: true` for this activity, but omits the condition text. The course page renders the condition in `.availabilityinfo` beside the unlinked activity name.
