<?php
// Generates the known data set for the Moodle CLI test harness, using Moodle's own
// data generators (lib/testing/generator + mod_*/tests/generator), and writes
// $LAB/ground-truth.json describing exactly what was created.
//
// Run:  php -d max_input_vars=5000 scripts/lab/generate.php
//
// Idempotent: users are reused (passwords reset); LAB101 and LAB202 are deleted and
// recreated on every run so that all "now +/- N days" dates are fresh. Course, cm and
// attempt ids therefore change between runs; always read ground-truth.json.

use mod_quiz\quiz_attempt;
use mod_quiz\quiz_settings;

define('CLI_SCRIPT', true);

$LAB = getenv('MOODLE_LAB_DIR') ?: getenv('HOME') . '/.cache/moodle-cli-lab';
require($LAB . '/moodle/config.php');
require_once($CFG->libdir . '/clilib.php');
require_once($CFG->libdir . '/testing/generator/lib.php');
require_once($CFG->dirroot . '/course/lib.php');
require_once($CFG->dirroot . '/course/modlib.php');
require_once($CFG->libdir . '/gradelib.php');
require_once($CFG->libdir . '/questionlib.php');
require_once($CFG->libdir . '/enrollib.php');
require_once($CFG->libdir . '/resourcelib.php');
require_once($CFG->dirroot . '/mod/assign/locallib.php');
require_once($CFG->dirroot . '/mod/quiz/locallib.php');
require_once($CFG->dirroot . '/mod/forum/lib.php');
require_once($CFG->dirroot . '/calendar/lib.php');

global $DB, $USER;

// Generators write a lot of debugging noise that is irrelevant here.
$CFG->debug = 0;
$CFG->debugdisplay = 0;

$now = time();
$DAY = 86400;
$log = static function (string $m): void {
    fwrite(STDERR, $m . "\n");
};

$gen = new testing_data_generator();
$admin = get_admin();

function as_user(stdClass $user): void {
    \core\session\manager::init_empty_session();
    \core\session\manager::set_user($user);
}

// ---------------------------------------------------------------------------------------
// Fixture files (small but valid).
// ---------------------------------------------------------------------------------------

/** Build a minimal, valid one-page PDF containing $text, with a correct xref table. */
function lab_make_pdf(string $text): string {
    $esc = str_replace(['\\', '(', ')'], ['\\\\', '\\(', '\\)'], $text);
    $stream = "BT /F1 24 Tf 72 700 Td ($esc) Tj ET";
    $objs = [
        1 => '<< /Type /Catalog /Pages 2 0 R >>',
        2 => '<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
        3 => '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Contents 4 0 R '
            . '/Resources << /Font << /F1 5 0 R >> >> >>',
        4 => '<< /Length ' . strlen($stream) . " >>\nstream\n$stream\nendstream",
        5 => '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>',
    ];
    $out = "%PDF-1.4\n";
    $offsets = [];
    foreach ($objs as $n => $body) {
        $offsets[$n] = strlen($out);
        $out .= "$n 0 obj\n$body\nendobj\n";
    }
    $xref = strlen($out);
    $out .= "xref\n0 " . (count($objs) + 1) . "\n0000000000 65535 f \n";
    foreach ($offsets as $off) {
        $out .= sprintf("%010d 00000 n \n", $off);
    }
    $out .= "trailer\n<< /Size " . (count($objs) + 1) . " /Root 1 0 R >>\nstartxref\n$xref\n%%EOF\n";
    return $out;
}

$fixtures = [
    'slides.pdf'      => lab_make_pdf('Lab Course One - Lecture Slides'),
    'reading1.pdf'    => lab_make_pdf('Lab Course One - Reading 1'),
    'reading2.txt'    => "Reading 2 for Lab Course One.\nThis is a small plain text file.\n",
    'essay-zero.txt'  => "Essay Zero by Sam Student.\nA short essay used as a graded submission.\n",
];
@mkdir($LAB . '/fixtures', 0777, true);
foreach ($fixtures as $name => $bytes) {
    file_put_contents($LAB . '/fixtures/' . $name, $bytes);
}

/** Create a draft area in the current user's context holding the given fixtures. */
function lab_make_draft(array $names, string $fixturedir): int {
    global $USER;
    $fs = get_file_storage();
    $itemid = file_get_unused_draft_itemid();
    foreach ($names as $name) {
        $fs->create_file_from_pathname([
            'contextid' => context_user::instance($USER->id)->id,
            'component' => 'user', 'filearea' => 'draft', 'itemid' => $itemid,
            'filepath' => '/', 'filename' => $name,
        ], $fixturedir . '/' . $name);
    }
    return $itemid;
}

// ---------------------------------------------------------------------------------------
// Users.
// ---------------------------------------------------------------------------------------

function lab_ensure_user(testing_data_generator $gen, array $spec): stdClass {
    global $DB, $CFG;
    $existing = $DB->get_record('user', ['username' => $spec['username'], 'mnethostid' => $CFG->mnet_localhost_id]);
    $fields = [
        'firstname' => $spec['firstname'], 'lastname' => $spec['lastname'], 'email' => $spec['email'],
        // Explicit blanks so the generator does not fill these with random names.
        'firstnamephonetic' => '', 'lastnamephonetic' => '', 'middlename' => '', 'alternatename' => '',
        'lang' => 'en', 'deleted' => 0, 'suspended' => 0, 'confirmed' => 1, 'auth' => 'manual',
    ];
    if ($existing) {
        $fields['id'] = $existing->id;
        $DB->update_record('user', (object) $fields);
        $user = $DB->get_record('user', ['id' => $existing->id], '*', MUST_EXIST);
        update_internal_user_password($user, $spec['password']);
        return $DB->get_record('user', ['id' => $existing->id], '*', MUST_EXIST);
    }
    return $gen->create_user(['username' => $spec['username'], 'password' => $spec['password']] + $fields);
}

$userspecs = [
    'student1' => ['username' => 'student1', 'password' => 'Student#2026lab', 'firstname' => 'Sam',
        'lastname' => 'Student', 'email' => 'student1@example.com'],
    'teacher1' => ['username' => 'teacher1', 'password' => 'Teacher#2026lab', 'firstname' => 'Tess',
        'lastname' => 'Teacher', 'email' => 'teacher1@example.com'],
];

as_user($admin);
$student = lab_ensure_user($gen, $userspecs['student1']);
$teacher = lab_ensure_user($gen, $userspecs['teacher1']);
$log("users: student1={$student->id} teacher1={$teacher->id}");

// ---------------------------------------------------------------------------------------
// Courses (deleted and recreated).
// ---------------------------------------------------------------------------------------

foreach (['LAB101', 'LAB202'] as $short) {
    if ($old = $DB->get_record('course', ['shortname' => $short])) {
        $log("deleting existing course $short (id {$old->id})");
        delete_course($old, false);
    }
}
fix_course_sortorder();

as_user($admin);

$course1 = $gen->create_course([
    'fullname' => 'Lab Course One', 'shortname' => 'LAB101', 'idnumber' => 'LAB101',
    'format' => 'topics', 'numsections' => 3, 'newsitems' => 5,
    'summary' => '<p>Lab Course One, the main fixture course.</p>', 'summaryformat' => FORMAT_HTML,
    'startdate' => $now - 30 * $DAY, 'enddate' => $now + 90 * $DAY,
]);
$course2 = $gen->create_course([
    'fullname' => 'Lab Course Two', 'shortname' => 'LAB202', 'idnumber' => 'LAB202',
    'format' => 'weeks', 'numsections' => 8, 'newsitems' => 5,
    'summary' => '<p>Lab Course Two, a small weekly-format course.</p>', 'summaryformat' => FORMAT_HTML,
    'startdate' => $now - 7 * $DAY, 'enddate' => $now + 60 * $DAY,
]);

$gen->enrol_user($student->id, $course1->id, 'student');
$gen->enrol_user($teacher->id, $course1->id, 'editingteacher');
$gen->enrol_user($student->id, $course2->id, 'student');

$assigngen = $gen->get_plugin_generator('mod_assign');
$quizgen = $gen->get_plugin_generator('mod_quiz');
$forumgen = $gen->get_plugin_generator('mod_forum');
$qgen = $gen->get_plugin_generator('core_question');

/** Settings shared by every assign: file submissions on, no drafts (submissions go straight to "submitted"). */
function lab_assign_defaults(): array {
    return [
        'assignsubmission_file_enabled' => 1,
        'assignsubmission_file_maxfiles' => 3,
        'assignsubmission_file_maxsizebytes' => 10485760,
        'assignsubmission_onlinetext_enabled' => 0,
        'assignfeedback_comments_enabled' => 1,
        'submissiondrafts' => 0,
        'alwaysshowdescription' => 1,
    ];
}

// ---------------------------------------------------------------------------------------
// LAB101 content.
// ---------------------------------------------------------------------------------------

$essayone = $assigngen->create_instance([
    'course' => $course1->id, 'name' => 'Essay One',
    'intro' => '<p>Write an essay. Not yet submitted by the student.</p>', 'introformat' => FORMAT_HTML,
    'duedate' => $now + 7 * $DAY, 'grade' => 10,
] + lab_assign_defaults(), ['section' => 1]);

$essayzero = $assigngen->create_instance([
    'course' => $course1->id, 'name' => 'Essay Zero',
    'intro' => '<p>A warm-up essay that is already submitted and graded.</p>', 'introformat' => FORMAT_HTML,
    'duedate' => $now - 7 * $DAY, 'grade' => 10,
] + lab_assign_defaults(), ['section' => 1]);

// Quiz with two questions living in the quiz's own question bank context.
$quiz = $quizgen->create_instance([
    'course' => $course1->id, 'name' => 'Quiz One',
    'intro' => '<p>Two questions, two attempts allowed.</p>', 'introformat' => FORMAT_HTML,
    'attempts' => 2, 'timeopen' => 0, 'timeclose' => $now + 14 * $DAY,
    'grade' => 10, 'preferredbehaviour' => 'deferredfeedback',
    // Review options: everything visible in every phase (during, right after, later while open, after close).
    'attemptduring' => 1, 'correctnessduring' => 1, 'maxmarksduring' => 1, 'marksduring' => 1,
    'specificfeedbackduring' => 1, 'generalfeedbackduring' => 1, 'rightanswerduring' => 1,
    'attemptimmediately' => 1, 'correctnessimmediately' => 1, 'maxmarksimmediately' => 1, 'marksimmediately' => 1,
    'specificfeedbackimmediately' => 1, 'generalfeedbackimmediately' => 1, 'rightanswerimmediately' => 1,
    'overallfeedbackimmediately' => 1,
    'attemptopen' => 1, 'correctnessopen' => 1, 'maxmarksopen' => 1, 'marksopen' => 1,
    'specificfeedbackopen' => 1, 'generalfeedbackopen' => 1, 'rightansweropen' => 1, 'overallfeedbackopen' => 1,
    'attemptclosed' => 1, 'correctnessclosed' => 1, 'maxmarksclosed' => 1, 'marksclosed' => 1,
    'specificfeedbackclosed' => 1, 'generalfeedbackclosed' => 1, 'rightanswerclosed' => 1,
    'overallfeedbackclosed' => 1,
], ['section' => 1]);

$qcat = $qgen->create_question_category([
    'name' => 'Quiz One questions', 'contextid' => context_module::instance($quiz->cmid)->id,
]);

/** Save a question straight through the qtype API (the stock test helpers need PHPUnit classes). */
function lab_save_question(string $qtype, int $categoryid, stdClass $form): stdClass {
    $q = new stdClass();
    $q->qtype = $qtype;
    $q->createdby = 0;
    $q->idnumber = null;
    $q->status = \core_question\local\bank\question_version_status::QUESTION_STATUS_READY;
    $form->category = (string) $categoryid;
    $form->status = $q->status;
    return question_bank::get_qtype($qtype)->save_question($q, $form);
}
$html = static fn(string $t): array => ['text' => $t, 'format' => FORMAT_HTML];

$tf = new stdClass();
$tf->name = 'Earth orbits the Sun';
$tf->questiontext = $html('<p>The Earth orbits the Sun.</p>');
$tf->generalfeedback = $html('<p>The Earth orbits the Sun once per year.</p>');
$tf->defaultmark = 1;
$tf->correctanswer = '1';
$tf->feedbacktrue = $html('Correct.');
$tf->feedbackfalse = $html('Incorrect.');
$tf->penalty = 1;
$q1 = lab_save_question('truefalse', $qcat->id, $tf);

$mc = new stdClass();
$mc->name = 'Closest planet to the Sun';
$mc->questiontext = $html('<p>Which planet is closest to the Sun?</p>');
$mc->generalfeedback = $html('<p>Mercury is the closest planet to the Sun.</p>');
$mc->defaultmark = 1;
$mc->penalty = 0.3333333;
$mc->shuffleanswers = 0;
$mc->answernumbering = 'abc';
$mc->showstandardinstruction = 0;
$mc->single = '1';
$mc->correctfeedback = $html('Your answer is correct.');
$mc->partiallycorrectfeedback = $html('Your answer is partially correct.');
$mc->incorrectfeedback = $html('Your answer is incorrect.');
$mc->shownumcorrect = 1;
$mc->fraction = ['1.0', '0.0', '0.0', '0.0'];
$mc->answer = [$html('Mercury'), $html('Venus'), $html('Earth'), $html('Mars')];
$mc->feedback = [$html('Yes.'), $html('No, Venus is second.'), $html('No, Earth is third.'), $html('No, Mars is fourth.')];
$mc->noanswers = 4;
$mc->numhints = 0;
$q2 = lab_save_question('multichoice', $qcat->id, $mc);

quiz_add_quiz_question($q1->id, $quiz, 1);
quiz_add_quiz_question($q2->id, $quiz, 2);
// quiz_add_quiz_question() does not touch sumgrades; without this the quiz refuses attempts.
quiz_settings::create($quiz->id)->get_grade_calculator()->recompute_quiz_sumgrades();
$quizcmid = $quiz->cmid;
$quiz = $DB->get_record('quiz', ['id' => $quiz->id], '*', MUST_EXIST);
$quiz->cmid = $quizcmid;

$slides = (function () use ($course1, $LAB) {
    $draft = lab_make_draft(['slides.pdf'], $LAB . '/fixtures');
    return $GLOBALS['gen']->get_plugin_generator('mod_resource')->create_instance([
        'course' => $course1->id, 'name' => 'Lecture Slides',
        'intro' => '<p>Slides for the first lecture.</p>', 'introformat' => FORMAT_HTML,
        'files' => $draft, 'showsize' => 1, 'showtype' => 1,
    ], ['section' => 1]);
})();

$readings = (function () use ($course1, $LAB) {
    $draft = lab_make_draft(['reading1.pdf', 'reading2.txt'], $LAB . '/fixtures');
    return $GLOBALS['gen']->get_plugin_generator('mod_folder')->create_instance([
        'course' => $course1->id, 'name' => 'Readings',
        'intro' => '<p>Weekly readings.</p>', 'introformat' => FORMAT_HTML,
        'files' => $draft, 'showexpanded' => 1,
    ], ['section' => 1]);
})();

$urlmod = $gen->get_plugin_generator('mod_url')->create_instance([
    'course' => $course1->id, 'name' => 'Course Website', 'externalurl' => 'https://example.org/',
    'intro' => '<p>The external course website.</p>', 'introformat' => FORMAT_HTML,
], ['section' => 1]);

$welcomepage = $gen->get_plugin_generator('mod_page')->create_instance([
    'course' => $course1->id, 'name' => 'Welcome Page',
    'intro' => '<p>Start here.</p>', 'introformat' => FORMAT_HTML,
    'content' => '<p>Welcome to Lab Course One. This page explains how the course runs.</p>',
    'contentformat' => FORMAT_HTML,
], ['section' => 1]);

$label = $gen->get_plugin_generator('mod_label')->create_instance([
    'course' => $course1->id,
    'intro' => '<p>Remember to read the week 1 material first.</p>', 'introformat' => FORMAT_HTML,
], ['section' => 1]);

// Section 2.
$forum = $forumgen->create_instance([
    'course' => $course1->id, 'name' => 'General Discussion', 'type' => 'general',
    'intro' => '<p>Ask anything about the course here.</p>', 'introformat' => FORMAT_HTML,
], ['section' => 2]);

$lockedts = $now + 30 * $DAY;
$locked = $assigngen->create_instance([
    'course' => $course1->id, 'name' => 'Locked Task',
    'intro' => '<p>Not available until 30 days from now.</p>', 'introformat' => FORMAT_HTML,
    'grade' => 10,
    'availability' => json_encode([
        'op' => '&', 'c' => [['type' => 'date', 'd' => '>=', 't' => $lockedts]], 'showc' => [true],
    ]),
] + lab_assign_defaults(), ['section' => 2]);

$hiddenpage = $gen->get_plugin_generator('mod_page')->create_instance([
    'course' => $course1->id, 'name' => 'Hidden Page',
    'intro' => '<p>Teachers only.</p>', 'introformat' => FORMAT_HTML,
    'content' => '<p>This page is hidden from students.</p>', 'contentformat' => FORMAT_HTML,
], ['section' => 2, 'visible' => 0]);

// Forum content.
$disc = $forumgen->create_discussion([
    'course' => $course1->id, 'forum' => $forum->id, 'userid' => $teacher->id,
    'name' => 'Week one questions', 'subject' => 'Week one questions',
    'message' => '<p>Post any questions about week one here.</p>', 'messageformat' => FORMAT_HTML,
    'timecreated' => $now - 2 * $DAY,
]);
$reply = $forumgen->create_post([
    'discussion' => $disc->id, 'parent' => $disc->firstpost, 'userid' => $student->id,
    'subject' => 'Re: Week one questions', 'message' => '<p>When is Essay One due?</p>',
    'messageformat' => FORMAT_HTML, 'created' => $now - 1 * $DAY, 'modified' => $now - 1 * $DAY,
]);

// Announcements (the course's news forum, created on demand by core).
$news = forum_get_course_forum($course1->id, 'news');
$newsdisc = $forumgen->create_discussion([
    'course' => $course1->id, 'forum' => $news->id, 'userid' => $teacher->id,
    'name' => 'Welcome to the course', 'subject' => 'Welcome to the course',
    'message' => '<p>Welcome to Lab Course One. Check the Welcome Page first.</p>', 'messageformat' => FORMAT_HTML,
    'timecreated' => $now - 3 * $DAY,
]);

// ---------------------------------------------------------------------------------------
// LAB202 content.
// ---------------------------------------------------------------------------------------

$report = $assigngen->create_instance([
    'course' => $course2->id, 'name' => 'Report',
    'intro' => '<p>Submit your report.</p>', 'introformat' => FORMAT_HTML,
    'duedate' => $now + 10 * $DAY, 'grade' => 100,
] + lab_assign_defaults(), ['section' => 1]);

$notes = $gen->get_plugin_generator('mod_page')->create_instance([
    'course' => $course2->id, 'name' => 'Notes',
    'intro' => '<p>Course notes.</p>', 'introformat' => FORMAT_HTML,
    'content' => '<p>Notes for Lab Course Two.</p>', 'contentformat' => FORMAT_HTML,
], ['section' => 1]);

// ---------------------------------------------------------------------------------------
// Student activity: Essay Zero submission + teacher grade, quiz attempt.
// ---------------------------------------------------------------------------------------

as_user($admin);
$assigngen->create_submission([
    'userid' => $student->id, 'cmid' => $essayzero->cmid, 'file' => '../fixtures/essay-zero.txt',
]);
// Back-date the submission to just before the due date so the status reads "submitted on time".
$submitted = $essayzero->duedate - $DAY;
$DB->set_field('assign_submission', 'timecreated', $submitted, ['assignment' => $essayzero->id, 'userid' => $student->id]);
$DB->set_field('assign_submission', 'timemodified', $submitted, ['assignment' => $essayzero->id, 'userid' => $student->id]);

as_user($teacher);
[$c0, $cm0] = get_course_and_cm_from_cmid($essayzero->cmid, 'assign');
$assign0 = new assign(context_module::instance($cm0->id), $cm0, $c0);
$gd = new stdClass();
$gd->attemptnumber = -1;
$gd->grade = '8';
$gd->assignfeedbackcomments_editor = ['text' => 'Good work', 'format' => FORMAT_HTML];
$gd->sendstudentnotifications = false;
$assign0->save_grade($student->id, $gd);

// Quiz: student answers question 1 correctly and question 2 wrongly, then finishes the attempt.
as_user($student);
$attempt = $quizgen->create_attempt($quiz->id, $student->id);
// (The generator's submit_responses() needs PHPUNIT_TEST, so build the POST data with the public attempt API.)
$attemptobj = quiz_attempt::create($attempt->id);
$post = [];
foreach ($attemptobj->get_slots() as $slot) {
    $qa = $attemptobj->get_question_attempt($slot);
    $question = $qa->get_question();
    $post[$qa->get_control_field_name('sequencecheck')] = (string) $qa->get_sequence_check_count();
    $post[$qa->get_flag_field_name()] = '0';
    if ($question->qtype->name() === 'truefalse') {
        $post[$qa->get_qt_field_name('answer')] = '1'; // "True": correct.
    } else {
        // The displayed choice order is stored in the first step ("_order": comma separated answer ids).
        $order = explode(',', $qa->get_step(0)->get_qt_var('_order'));
        foreach ($order as $key => $answerid) {
            if (trim(strip_tags($question->answers[$answerid]->answer)) === 'Venus') { // Wrong on purpose.
                $post[$qa->get_qt_field_name('answer')] = (string) $key;
            }
        }
    }
}
$attemptobj->process_submitted_actions(time(), false, $post);
$attemptobj = quiz_attempt::create($attempt->id);
$attemptobj->process_submit(time(), false);
$attemptobj->process_grade_submission(time());
// The generator finishes the attempt in the same second it starts; give it a plausible 5 minute duration.
$DB->set_field('quiz_attempts', 'timestart', $DB->get_field('quiz_attempts', 'timefinish', ['id' => $attempt->id]) - 300, ['id' => $attempt->id]);

as_user($admin);

// The calendar events (assign due dates, quiz close) are created by the module generators, but
// refresh anyway so the result does not depend on that.
assign_refresh_events($course1->id);
assign_refresh_events($course2->id);
quiz_refresh_events($course1->id);
rebuild_course_cache($course1->id, true);
rebuild_course_cache($course2->id, true);

// ---------------------------------------------------------------------------------------
// Ground truth.
// ---------------------------------------------------------------------------------------

$fs = get_file_storage();
$base = $CFG->wwwroot;

$filesof = static function (context $ctx, string $component, string $area) use ($fs, $base): array {
    $out = [];
    foreach ($fs->get_area_files($ctx->id, $component, $area, false, 'filepath, filename', false) as $f) {
        $out[] = [
            'name' => $f->get_filename(),
            'size' => (int) $f->get_filesize(),
            'mimetype' => $f->get_mimetype(),
            'pluginfile_path' => moodle_url::make_pluginfile_url(
                $ctx->id, $component, $area, $f->get_itemid(), $f->get_filepath(), $f->get_filename()
            )->out_as_local_url(false),
        ];
    }
    return $out;
};

$describe = static function (stdClass $course) use ($DB, $student, $base, $filesof): array {
    $modinfo = get_fast_modinfo($course, $student->id);
    $acts = [];
    foreach ($modinfo->get_cms() as $cm) {
        $ctx = context_module::instance($cm->id);
        $inst = $DB->get_record($cm->modname, ['id' => $cm->instance], '*', MUST_EXIST);
        if (!$cm->visible) {
            $vis = 'hidden';
        } else if ($cm->uservisible) {
            $vis = 'visible';
        } else {
            $vis = 'restricted';
        }
        $a = [
            'cmid' => (int) $cm->id,
            'instance' => (int) $cm->instance,
            'modname' => $cm->modname,
            'name' => $cm->name,
            'section' => (int) $cm->sectionnum,
            'contextid' => (int) $ctx->id,
            'visibility_for_student' => $vis,
            'url' => "/mod/{$cm->modname}/view.php?id={$cm->id}",
        ];
        if ($vis === 'restricted') {
            $a['availability'] = json_decode($cm->availability);
            $a['availableinfo'] = strip_tags((string) $cm->availableinfo);
        }
        switch ($cm->modname) {
            case 'assign':
                $a['duedate'] = (int) $inst->duedate;
                $a['grademax'] = (float) $inst->grade;
                $a['submission_files_enabled'] = true;
                break;
            case 'quiz':
                $a['timeopen'] = (int) $inst->timeopen;
                $a['timeclose'] = (int) $inst->timeclose;
                $a['attempts_allowed'] = (int) $inst->attempts;
                $a['grademax'] = (float) $inst->grade;
                $a['sumgrades'] = (float) $inst->sumgrades;
                break;
            case 'resource':
                $a['files'] = $filesof($ctx, 'mod_resource', 'content');
                break;
            case 'folder':
                $a['files'] = $filesof($ctx, 'mod_folder', 'content');
                break;
            case 'url':
                $a['externalurl'] = $inst->externalurl;
                break;
            case 'forum':
                $a['forum_type'] = $inst->type;
                break;
            case 'label':
                $a['text'] = trim(strip_tags($inst->intro));
                break;
        }
        $acts[] = $a;
    }
    return $acts;
};

$sectionsof = static function (stdClass $course) use ($DB): array {
    $out = [];
    foreach ($DB->get_records('course_sections', ['course' => $course->id], 'section') as $s) {
        $out[] = ['section' => (int) $s->section, 'id' => (int) $s->id, 'name' => $s->name ?? null];
    }
    return $out;
};

// Essay Zero grade.
$g = $DB->get_record('assign_grades', ['assignment' => $essayzero->id, 'userid' => $student->id], '*', MUST_EXIST);
$fbc = $DB->get_record('assignfeedback_comments', ['grade' => $g->id]);
$gb = grade_get_grades($course1->id, 'mod', 'assign', $essayzero->id, $student->id);
$sub0 = $DB->get_record('assign_submission', ['assignment' => $essayzero->id, 'userid' => $student->id, 'latest' => 1], '*', MUST_EXIST);
$essayzeroctx = context_module::instance($essayzero->cmid);
$essayzerofiles = $filesof($essayzeroctx, 'assignsubmission_file', 'submission_files');

// Quiz attempt.
$qa = $DB->get_record('quiz_attempts', ['quiz' => $quiz->id, 'userid' => $student->id], '*', MUST_EXIST);
$attemptobj = quiz_attempt::create($qa->id);
$slots = [];
foreach ($attemptobj->get_slots() as $slot) {
    $qatt = $attemptobj->get_question_attempt($slot);
    $slots[] = [
        'slot' => (int) $slot,
        'question_name' => $qatt->get_question()->name,
        'qtype' => $qatt->get_question()->qtype->name(),
        'question_summary' => $qatt->get_question_summary(),
        'response_summary' => $qatt->get_response_summary(),
        'right_answer' => $qatt->get_right_answer_summary(),
        'mark' => (float) $qatt->get_mark(),
        'max_mark' => (float) $qatt->get_max_mark(),
        'correct' => $qatt->get_state()->is_correct(),
    ];
}
$qgrade = $DB->get_record('quiz_grades', ['quiz' => $quiz->id, 'userid' => $student->id]);

// Forum ground truth.
$discussions = [];
foreach ([[$forum, $disc], [$news, $newsdisc]] as [$f, $d]) {
    $fcm = get_coursemodule_from_instance('forum', $f->id, $course1->id, false, MUST_EXIST);
    $posts = [];
    foreach ($DB->get_records('forum_posts', ['discussion' => $d->id], 'id') as $p) {
        $posts[] = [
            'id' => (int) $p->id, 'parent' => (int) $p->parent, 'userid' => (int) $p->userid,
            'author' => $DB->get_field('user', 'username', ['id' => $p->userid]),
            'subject' => $p->subject, 'message' => trim(strip_tags($p->message)),
        ];
    }
    $discussions[] = [
        'id' => (int) $d->id, 'subject' => $d->name, 'forum_cmid' => (int) $fcm->id,
        'forum_name' => $f->name, 'forum_type' => $f->type, 'firstpost' => (int) $d->firstpost,
        'author' => $DB->get_field('user', 'username', ['id' => $d->userid]),
        'replies' => count($posts) - 1, 'posts' => $posts,
        'url' => "/mod/forum/discuss.php?d={$d->id}",
    ];
}

// Calendar events (course-module events only).
[$insql, $inparams] = $DB->get_in_or_equal([$course1->id, $course2->id]);
$events = [];
foreach ($DB->get_records_select('event', "courseid $insql AND modulename <> ''", $inparams, 'timestart, id') as $e) {
    $events[] = [
        'id' => (int) $e->id, 'name' => $e->name, 'courseid' => (int) $e->courseid, 'modulename' => $e->modulename,
        'instance' => (int) $e->instance, 'eventtype' => $e->eventtype, 'timestart' => (int) $e->timestart,
        'visible' => (int) $e->visible,
    ];
}

$truth = [
    'generated_at' => $now,
    'generated_at_iso' => gmdate('c', $now),
    'moodle_release' => $CFG->release,
    'base_url' => $base,
    'users' => [
        'student1' => ['id' => (int) $student->id, 'username' => 'student1', 'password' => $userspecs['student1']['password'],
            'firstname' => 'Sam', 'lastname' => 'Student', 'email' => 'student1@example.com'],
        'teacher1' => ['id' => (int) $teacher->id, 'username' => 'teacher1', 'password' => $userspecs['teacher1']['password'],
            'firstname' => 'Tess', 'lastname' => 'Teacher', 'email' => 'teacher1@example.com'],
        'admin' => ['id' => (int) $admin->id, 'username' => 'admin', 'password' => 'Admin#2026lab'],
    ],
    'student1_userid' => (int) $student->id,
    'courses' => [
        [
            'id' => (int) $course1->id, 'shortname' => 'LAB101', 'fullname' => 'Lab Course One', 'format' => 'topics',
            'startdate' => (int) $course1->startdate, 'enddate' => (int) $course1->enddate,
            'url' => "/course/view.php?id={$course1->id}",
            'sections' => $sectionsof($course1),
            'activities' => $describe($course1),
        ],
        [
            'id' => (int) $course2->id, 'shortname' => 'LAB202', 'fullname' => 'Lab Course Two', 'format' => 'weeks',
            'startdate' => (int) $course2->startdate, 'enddate' => (int) $course2->enddate,
            'url' => "/course/view.php?id={$course2->id}",
            'sections' => $sectionsof($course2),
            'activities' => $describe($course2),
        ],
    ],
    'essay_zero' => [
        'cmid' => (int) $essayzero->cmid, 'assign_id' => (int) $essayzero->id,
        'submission_status' => $sub0->status, 'submission_timemodified' => (int) $sub0->timemodified,
        'submission_files' => $essayzerofiles,
        'grade' => (float) $g->grade, 'grademax' => (float) $essayzero->grade,
        'gradebook_grade' => isset($gb->items[0]->grades[$student->id]) ? (float) $gb->items[0]->grades[$student->id]->grade : null,
        'feedback_comment' => $fbc ? trim(strip_tags($fbc->commenttext)) : null,
        'grader' => 'teacher1', 'duedate' => (int) $essayzero->duedate,
    ],
    'quiz_attempt' => [
        'quiz_cmid' => (int) $quiz->cmid, 'quiz_id' => (int) $quiz->id, 'attempt_id' => (int) $qa->id,
        'attempt_number' => (int) $qa->attempt, 'state' => $qa->state, 'sumgrades' => (float) $qa->sumgrades,
        'quiz_sumgrades' => (float) $quiz->sumgrades, 'timefinish' => (int) $qa->timefinish,
        'grade' => $qgrade ? (float) $qgrade->grade : null, 'grademax' => (float) $quiz->grade,
        'review_url' => "/mod/quiz/review.php?attempt={$qa->id}&cmid={$quiz->cmid}",
        'slots' => $slots,
    ],
    'forum_discussions' => $discussions,
    'calendar_events' => $events,
];

$json = json_encode($truth, JSON_PRETTY_PRINT | JSON_UNESCAPED_SLASHES | JSON_UNESCAPED_UNICODE);
file_put_contents($LAB . '/ground-truth.json', $json . "\n");
$log("wrote {$LAB}/ground-truth.json");
$log("LAB101 id={$course1->id} LAB202 id={$course2->id} attempt={$qa->id}");
