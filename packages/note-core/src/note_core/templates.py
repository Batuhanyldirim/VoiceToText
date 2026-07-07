"""Starter note templates (the sample formats fed to section A of the prompt).

Ship two clinician-recognizable picks — SOAP and H&P — plus a free-text path
where the user pastes their own sample format. The template text is inserted
verbatim into the user prompt (see prompt.build_user_prompt); it steers the
*format* of section A, while the system prompt governs extraction and safety.
"""
from __future__ import annotations

from dataclasses import dataclass


@dataclass(frozen=True)
class Template:
    key: str
    label: str
    description: str
    text: str


SOAP = Template(
    key="soap",
    label="SOAP note",
    description="Subjective, Objective, Assessment, Plan — the common outpatient format.",
    text="""\
# SOAP Note

## Subjective
- Chief complaint:
- History of present illness (HPI):
- Past medical / surgical history:
- Medications (name, dose, route, frequency, adherence):
- Allergies:
- Family history:
- Social history:
- Review of systems (ROS):

## Objective
- Vitals (only if stated):
- Physical exam findings (only if stated):
- Labs / imaging / other results (only if stated):

## Assessment
- Clinician's assessment / working problems (only as stated):

## Plan
- Management, medications started/changed/stopped:
- Orders, referrals, follow-up, return precautions:
""",
)

HP = Template(
    key="hp",
    label="H&P (History & Physical)",
    description="Full history and physical — the comprehensive admission/consult format.",
    text="""\
# History & Physical

## Identification / Demographics
- Patient, age, sex (only as stated):

## Chief Complaint

## History of Present Illness (HPI)

## Past Medical History (PMH)

## Past Surgical History (PSH)

## Medications
- (name, dose, route, frequency, adherence, changes)

## Allergies

## Family History

## Social History

## Review of Systems (ROS)

## Physical Examination
- (only findings actually mentioned)

## Results
- Labs / imaging / genetic / pathology (only as stated)

## Assessment

## Plan
- Orders, referrals, follow-up, return precautions
""",
)

TEMPLATES = {t.key: t for t in (SOAP, HP)}

# Public metadata the API/UI can list without importing the full text eagerly.
TEMPLATE_CHOICES = [
    {"key": t.key, "label": t.label, "description": t.description}
    for t in (SOAP, HP)
]


def resolve_template_text(template: str, template_text: str | None) -> str:
    """Return the sample-format text for a template key, or the user's pasted
    free-text. Raises ValueError on an unknown key or empty free-text."""
    key = (template or "").strip().lower()
    if key in ("free", "freetext", "free-text", "custom"):
        if not template_text or not template_text.strip():
            raise ValueError(
                "template='free' requires template_text (paste a sample note format)."
            )
        return template_text
    tpl = TEMPLATES.get(key)
    if tpl is None:
        valid = ", ".join(sorted(TEMPLATES)) + ", free"
        raise ValueError(f"unknown template '{template}'. Valid: {valid}")
    return tpl.text
