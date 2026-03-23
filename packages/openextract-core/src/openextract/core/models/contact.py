from __future__ import annotations

from pydantic import BaseModel


class ContactPhone(BaseModel):
    number: str
    label: str | None = None


class ContactEmail(BaseModel):
    address: str
    label: str | None = None


class ContactAddress(BaseModel):
    street: str | None = None
    city: str | None = None
    state: str | None = None
    postal_code: str | None = None
    country: str | None = None
    label: str | None = None


class Contact(BaseModel):
    id: int
    first_name: str | None = None
    last_name: str | None = None
    organization: str | None = None
    phones: list[ContactPhone] = []
    emails: list[ContactEmail] = []
    addresses: list[ContactAddress] = []
    note: str | None = None

    @property
    def display_name(self) -> str:
        parts = [p for p in [self.first_name, self.last_name] if p]
        if parts:
            return " ".join(parts)
        if self.organization:
            return self.organization
        if self.phones:
            return self.phones[0].number
        if self.emails:
            return self.emails[0].address
        return f"Contact #{self.id}"
