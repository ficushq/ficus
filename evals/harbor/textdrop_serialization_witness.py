"""Offline witness for an unspecified TextDrop HTML serialization requirement.

This does not modify upstream tests, execute a candidate, or compute a score.
"""

from html.parser import HTMLParser
import json


class Structure(HTMLParser):
    def __init__(self):
        super().__init__()
        self.events = []

    def handle_starttag(self, tag, attrs):
        self.events.append(("start", tag, sorted(attrs)))

    def handle_endtag(self, tag):
        self.events.append(("end", tag))

    def handle_data(self, data):
        if data.strip():
            self.events.append(("text", data))


def witness():
    compact = (
        '<nav class="table-of-contents"><ul><li><a href="#parent">Parent</a>'
        '<ul><li><a href="#child">Child</a><ul><li>'
        '<a href="#grandchild">Grandchild</a></li></ul></li></ul></li></ul></nav>'
    )
    spaced = compact.replace("</a><ul>", "</a>\n<ul>")
    first, second = Structure(), Structure()
    first.feed(compact)
    second.feed(spaced)
    assert first.events == second.events
    assert "Parent</a><ul>" in compact and "Child</a><ul>" in compact
    assert "Parent</a><ul>" not in spaced and "Child</a><ul>" not in spaced
    return {
        "same_element_attribute_and_nonwhitespace_text_structure": True,
        "compact_passes_two_literal_nesting_assertions": True,
        "intertag_newlines_fail_two_literal_nesting_assertions": True,
        "candidate_execution_or_grade": False,
        "scope": "Structural witness only; no claim to satisfy the entire service specification",
    }


if __name__ == "__main__":
    print(json.dumps(witness(), indent=2))
